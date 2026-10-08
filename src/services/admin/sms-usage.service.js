'use strict';

const prisma = require('../../config/prisma');
const env = require('../../config/env');
const { errors } = require('../../utils/errors');
const { emitToAdmin } = require('../../sockets/bus');
const gcp = require('./gcp.service');
const P = require('../../utils/smsPricing');

/**
 * Firebase SMS OTP usage and cost.
 *
 * **Where the numbers come from, and why not anywhere closer.** The app asks
 * Firebase to send the SMS directly from the phone; this server only hears
 * about a sign-in after the code has been typed and checked. Counting "OTP
 * requests" in the app or here would count retries, resends, abandoned
 * screens and blocked sends as SMS — and miss sends from a build that never
 * reported. So:
 *
 *  * **Usage** is Google's own count, from Cloud Monitoring: SMS sent,
 *    verified and blocked (`identitytoolkit.googleapis.com/usage/*`), plus
 *    `sendVerificationCode` requests Google answered with an error.
 *  * **Estimated cost** applies the published price to Google's sent count:
 *    first N per *project* per billing day free, the rest at the rate.
 *  * **Actual cost** is what Google billed, from the Cloud Billing export in
 *    BigQuery. It lags usage by hours to a day and is shown separately,
 *    never blended into the estimate.
 *
 * Every sync re-reads a window of whole days and overwrites them. Nothing is
 * ever incremented, so a repeated or concurrent sync cannot double-count.
 */

const cfg = env.smsMonitoring;

/** 15-minute buckets: every real time zone's midnight falls on one. */
const BUCKET_SEC = 900;

const STATE_ID = 'sms';

function num(v) {
  return v == null ? null : Number(v);
}

// ── Pricing ─────────────────────────────────────────────────────────────────

async function state() {
  return (
    (await prisma.smsMonitorState.findUnique({ where: { id: STATE_ID } })) ?? { id: STATE_ID }
  );
}

function saveState(data) {
  return prisma.smsMonitorState.upsert({
    where: { id: STATE_ID },
    create: { id: STATE_ID, ...data },
    update: data,
  });
}

/** The pricing in force: the admin's override where set, the environment otherwise. */
function pricingFrom(s) {
  const overridden = s.rateUsd != null || s.usdToInr != null || s.freePerDay != null;
  return {
    rateUsd: s.rateUsd != null ? Number(s.rateUsd) : cfg.rateUsd,
    usdToInr: s.usdToInr != null ? Number(s.usdToInr) : cfg.usdToInr,
    freePerDay: s.freePerDay ?? cfg.freePerDay,
    pricedRegion: cfg.pricedRegion,
    source: overridden ? 'admin' : 'default',
    updatedAt: s.pricingUpdatedAt ?? null,
  };
}

function usageRowData(day, raw, pricing) {
  // Monitoring sums can arrive as doubles; an SMS is a whole thing.
  const int = (v) => Math.max(0, Math.round(Number(v) || 0));
  const regions = Object.fromEntries(
    Object.entries(raw.regions ?? {}).map(([code, r]) => [
      code,
      { sent: int(r.sent), verified: int(r.verified), blocked: int(r.blocked) },
    ])
  );
  const counts = {
    sent: int(raw.sent),
    verified: int(raw.verified),
    blocked: int(raw.blocked),
    failed: int(raw.failed),
    regions,
  };
  const priced = P.priceDay(counts, pricing);
  return {
    ...counts,
    ...priced,
    rateUsd: pricing.rateUsd,
    usdToInr: pricing.usdToInr,
    freePerDay: pricing.freePerDay,
  };
}

// ── Usage sync (Cloud Monitoring) ───────────────────────────────────────────

async function syncUsage(now = new Date()) {
  const s = await state();
  const pricing = pricingFrom(s);
  const tz = cfg.timezone;

  const hasHistory = (await prisma.smsUsageDay.count()) > 0;
  const lookback = Math.max(1, hasHistory ? cfg.usageLookbackDays : cfg.usageBackfillDays);
  const today = P.dayOf(now, tz);
  const firstDay = P.addDays(today, -(lookback - 1));
  const start = P.startOfDay(firstDay, tz);

  // Whole buckets up to the last boundary, then one short bucket for the
  // minutes since — so today is current, and no bucket straddles midnight.
  const boundary = new Date(Math.floor(now.getTime() / (BUCKET_SEC * 1000)) * BUCKET_SEC * 1000);
  const tailSec = Math.floor((now - boundary) / 1000);
  const windows = [{ start, end: boundary, periodSec: BUCKET_SEC }];
  if (tailSec >= 60) {
    windows.push({ start: boundary, end: new Date(boundary.getTime() + tailSec * 1000), periodSec: tailSec });
  }

  const days = new Map(
    P.daysBetween(firstDay, today).map((d) => [
      d,
      { sent: 0, verified: 0, blocked: 0, failed: 0, regions: {} },
    ])
  );
  const bucketDay = (end) => P.dayOf(new Date(end.getTime() - 1), tz);

  // `sent` is the billable figure — if it cannot be read, the sync fails
  // rather than writing zeros over real history.
  const optionalFailures = [];
  const read = async (fn, label, required) => {
    try {
      return (await Promise.all(windows.map((w) => fn(w)))).flat();
    } catch (err) {
      if (required) throw err;
      optionalFailures.push(`${label}: ${err.message}`);
      return null;
    }
  };

  const [sent, verified, blocked, requests] = await Promise.all([
    read((w) => gcp.smsMetric('sent', w), 'sent', true),
    read((w) => gcp.smsMetric('verified', w), 'verified', false),
    read((w) => gcp.smsMetric('blocked', w), 'blocked', false),
    read((w) => gcp.sendRequestsByClass(w), 'failed requests', false),
  ]);

  const add = (points, field) => {
    for (const p of points ?? []) {
      const row = days.get(bucketDay(p.end));
      if (!row) continue;
      row[field] += p.value;
      const region = (p.labels.region_code || 'unknown').toUpperCase();
      row.regions[region] ??= { sent: 0, verified: 0, blocked: 0 };
      row.regions[region][field] += p.value;
    }
  };
  add(sent, 'sent');
  add(verified, 'verified');
  add(blocked, 'blocked');
  for (const p of requests ?? []) {
    if (String(p.labels.response_code_class || '').startsWith('2')) continue;
    const row = days.get(bucketDay(p.end));
    if (row) row.failed += p.value;
  }

  // A metric that failed to load is left as it was rather than zeroed.
  const keep = new Set([
    ...(verified ? [] : ['verified']),
    ...(blocked ? [] : ['blocked']),
    ...(requests ? [] : ['failed']),
  ]);
  const existing = keep.size
    ? new Map(
        (await prisma.smsUsageDay.findMany({ where: { day: { gte: firstDay } } })).map((r) => [r.day, r])
      )
    : new Map();

  await prisma.$transaction(
    [...days.entries()].map(([day, counts]) => {
      const prev = existing.get(day);
      for (const field of keep) counts[field] = prev?.[field] ?? 0;
      const data = usageRowData(day, counts, pricing);
      return prisma.smsUsageDay.upsert({ where: { day }, create: { day, ...data }, update: data });
    })
  );

  const through = windows[windows.length - 1].end;
  await saveState({
    usageSyncedAt: now,
    usageAttemptAt: now,
    usageDataThrough: through,
    usageError: optionalFailures.length ? `Partial: ${optionalFailures.join('; ')}`.slice(0, 1000) : null,
  });

  return { days: days.size, from: firstDay, to: today };
}

// ── Billing sync (BigQuery export) ──────────────────────────────────────────

/** A billed amount in rupees, whatever currency the billing account uses. */
function toInr({ netCost, currency, conversionRate }, usdToInr) {
  if (currency === 'INR') return netCost;
  if (currency === 'USD') return netCost * usdToInr;
  // Google's rate is USD → billing currency, so divide back to USD first.
  if (conversionRate) return (netCost / conversionRate) * usdToInr;
  return null;
}

async function syncBilling(now = new Date()) {
  const s = await state();
  const pricing = pricingFrom(s);
  const tz = cfg.timezone;

  const hasHistory = (await prisma.smsBillingDay.count()) > 0;
  const firstDay = hasHistory
    ? P.addDays(P.dayOf(now, tz), -(cfg.billingLookbackDays - 1))
    : null;
  // First run reads everything the export has; later runs, the window
  // Google may still be revising.
  const since = firstDay ? P.startOfDay(firstDay, tz) : new Date('2000-01-01T00:00:00Z');

  const rows = await gcp.smsBilling({ since, timeZone: tz, projectId: cfg.projectId });

  // One row per day: a billing account has one currency, but merge anyway.
  const byDay = new Map();
  for (const r of rows) {
    const netCost = r.cost + r.credits;
    const inr = toInr({ netCost, currency: r.currency, conversionRate: r.conversionRate }, pricing.usdToInr);
    const prev = byDay.get(r.day);
    if (prev) {
      prev.cost += r.cost;
      prev.credits += r.credits;
      prev.netCost += netCost;
      prev.netCostInr += inr ?? 0;
      prev.billedSms += r.billedSms;
      if (r.exportedAt && (!prev.exportedAt || r.exportedAt > prev.exportedAt)) prev.exportedAt = r.exportedAt;
    } else {
      byDay.set(r.day, {
        currency: r.currency,
        cost: r.cost,
        credits: r.credits,
        netCost,
        netCostInr: inr ?? 0,
        billedSms: r.billedSms,
        conversionRate: r.conversionRate,
        exportedAt: r.exportedAt,
      });
    }
  }

  const ops = [...byDay.entries()].map(([day, d]) => {
    const data = {
      ...d,
      cost: P.round4(d.cost),
      credits: P.round4(d.credits),
      netCost: P.round4(d.netCost),
      netCostInr: P.round4(d.netCostInr),
    };
    return prisma.smsBillingDay.upsert({ where: { day }, create: { day, ...data }, update: data });
  });
  // A day inside the window that no longer has SMS rows was revised to
  // nothing; drop it rather than keep showing a charge Google withdrew.
  ops.push(
    prisma.smsBillingDay.deleteMany({
      where: { ...(firstDay ? { day: { gte: firstDay } } : {}), NOT: { day: { in: [...byDay.keys()] } } },
    })
  );
  await prisma.$transaction(ops);

  const skus = [...new Set(rows.flatMap((r) => r.skus.split(' | ')).filter(Boolean))];
  await saveState({ billingSyncedAt: now, billingAttemptAt: now, billingError: null });
  return { days: byDay.size, skus };
}

// ── Orchestration ───────────────────────────────────────────────────────────

let running = null;

/**
 * Syncs usage, then billing. One at a time per process; a second caller
 * waits for the run in flight instead of starting another.
 */
function sync({ reason = 'schedule' } = {}) {
  if (!cfg.usageConfigured) return Promise.resolve({ skipped: 'not_configured' });
  if (running) return running;

  running = (async () => {
    const now = new Date();
    const result = { reason };

    try {
      result.usage = await syncUsage(now);
    } catch (err) {
      console.error('[sms-usage] usage sync failed:', err.message);
      await saveState({ usageAttemptAt: now, usageError: String(err.message).slice(0, 1000) }).catch(() => {});
      result.usageError = err.message;
    }

    if (cfg.billingConfigured) {
      try {
        result.billing = await syncBilling(now);
      } catch (err) {
        console.error('[sms-usage] billing sync failed:', err.message);
        await saveState({ billingAttemptAt: now, billingError: String(err.message).slice(0, 1000) }).catch(() => {});
        result.billingError = err.message;
      }
    }

    emitToAdmin('admin:sms_usage_synced', { at: now.toISOString() });
    return result;
  })().finally(() => {
    running = null;
  });

  return running;
}

/** Runs [sync] now and every `SMS_SYNC_INTERVAL_MINUTES`. */
function scheduleSync() {
  if (!cfg.usageConfigured) {
    if (cfg.enabled) {
      console.info('[sms-usage] no Google Cloud service account — SMS usage dashboard will show as not configured');
    }
    return;
  }
  const tick = () => sync().catch((err) => console.error('[sms-usage] sync crashed', err));
  // Off the boot path: a slow Google call must not delay the server listening.
  setTimeout(tick, 5_000).unref();
  setInterval(tick, Math.max(5, cfg.syncIntervalMinutes) * 60_000).unref();
}

// ── Reading ─────────────────────────────────────────────────────────────────

function emptyTotals() {
  return {
    sent: 0, verified: 0, blocked: 0, failed: 0,
    free: 0, paid: 0, unpriced: 0,
    est_cost_usd: 0, est_cost_inr: 0,
  };
}

function addUsage(t, r) {
  t.sent += r.sent;
  t.verified += r.verified;
  t.blocked += r.blocked;
  t.failed += r.failed;
  t.free += r.freeSms;
  t.paid += r.paidSms;
  t.unpriced += r.unpricedSms;
  t.est_cost_usd += Number(r.estCostUsd);
  t.est_cost_inr += Number(r.estCostInr);
  return t;
}

function finishTotals(t) {
  t.est_cost_usd = P.round4(t.est_cost_usd);
  t.est_cost_inr = P.round4(t.est_cost_inr);
  // Codes Google sent that nobody entered — the cost of abandoned sign-ins.
  t.unverified = Math.max(0, t.sent - t.verified);
  t.verification_rate = t.sent > 0 ? Math.round((t.verified / t.sent) * 1000) / 10 : null;
  return t;
}

/**
 * Whether a day's actual charge can be read yet.
 *
 *  * `billed` — the export has it; `provisional` while Google may still revise.
 *  * `pending` — too recent to have been exported. Not the same as zero.
 *  * `none` — old enough to have been exported and nothing was charged
 *    (the free ten covered it, or nothing was sent).
 *  * `unavailable` — no billing export is configured or it has never synced.
 */
function billingStatus(day, bill, { today, billingReady, latestExport, tz }) {
  if (!billingReady) return 'unavailable';
  if (bill) return day >= P.addDays(today, -2) ? 'provisional' : 'billed';
  // "Nothing billed" only once the export has demonstrably moved past the
  // end of that day; before then, no row means "not exported yet".
  const exportedPast = latestExport && latestExport >= P.startOfDay(P.addDays(day, 1), tz);
  if (latestExport) return exportedPast ? 'none' : 'pending';
  return day >= P.addDays(today, -1) ? 'pending' : 'none';
}

function actualTotals(days, billing, ctx) {
  if (!ctx.billingReady) return null;
  let costInr = 0;
  let billedSms = 0;
  let billedDays = 0;
  let pendingDays = 0;
  let currency = null;
  for (const day of days) {
    const b = billing.get(day);
    if (b) {
      costInr += Number(b.netCostInr);
      billedSms += Number(b.billedSms);
      billedDays += 1;
      currency = b.currency;
    } else if (billingStatus(day, null, ctx) === 'pending') {
      pendingDays += 1;
    }
  }
  return {
    cost_inr: P.round4(costInr),
    billed_sms: billedSms,
    billed_days: billedDays,
    pending_days: pendingDays,
    complete: pendingDays === 0,
    currency,
  };
}

function serializeDay(r, bill, ctx) {
  const rateUsd = Number(r.rateUsd);
  const usdToInr = Number(r.usdToInr);
  const status = billingStatus(r.day, bill, ctx);
  return {
    day: r.day,
    sent: r.sent,
    verified: r.verified,
    unverified: Math.max(0, r.sent - r.verified),
    blocked: r.blocked,
    failed: r.failed,
    free: r.freeSms,
    paid: r.paidSms,
    unpriced: r.unpricedSms,
    regions: r.regions ?? {},
    rate_usd: rateUsd,
    usd_to_inr: usdToInr,
    rate_inr: P.round4(rateUsd * usdToInr),
    free_per_day: r.freePerDay,
    est_cost_usd: num(r.estCostUsd),
    est_cost_inr: num(r.estCostInr),
    billing_status: status,
    actual: bill
      ? {
          cost_inr: num(bill.netCostInr),
          net_cost: num(bill.netCost),
          gross_cost: num(bill.cost),
          credits: num(bill.credits),
          currency: bill.currency,
          billed_sms: num(bill.billedSms),
          exported_at: bill.exportedAt,
        }
      : null,
    synced_at: r.syncedAt,
  };
}

async function context(now = new Date()) {
  const [s, newest] = await Promise.all([
    state(),
    prisma.smsBillingDay.findFirst({ where: { exportedAt: { not: null } }, orderBy: { exportedAt: 'desc' } }),
  ]);
  const tz = cfg.timezone;
  return {
    latestExport: newest?.exportedAt ?? null,
    s,
    tz,
    now,
    today: P.dayOf(now, tz),
    pricing: pricingFrom(s),
    billingReady: cfg.billingConfigured && Boolean(s.billingSyncedAt),
  };
}

/** Sign-ins this server completed through Firebase — a cross-check, never billed from. */
async function backendSignIns(fromDay, ctx) {
  return prisma.userActivity.count({
    where: {
      type: 'otp_verified',
      createdAt: { gte: P.startOfDay(fromDay, ctx.tz) },
      metadata: { path: ['via'], equals: 'firebase' },
    },
  });
}

/**
 * Everything the dashboard's cards and chart need, in one response.
 *
 * `days` sizes the chart only; today, month and overall always cover their
 * whole periods.
 */
async function summary({ days = 30 } = {}) {
  const ctx = await context();
  const { today, pricing, s } = ctx;
  const monthStart = `${today.slice(0, 7)}-01`;

  const [usageRows, billingRows, signInsToday, signInsMonth] = await Promise.all([
    prisma.smsUsageDay.findMany({ orderBy: { day: 'asc' } }),
    prisma.smsBillingDay.findMany({ orderBy: { day: 'asc' } }),
    backendSignIns(today, ctx).catch(() => null),
    backendSignIns(monthStart, ctx).catch(() => null),
  ]);
  const billing = new Map(billingRows.map((b) => [b.day, b]));

  const todayT = emptyTotals();
  const monthT = emptyTotals();
  const overallT = emptyTotals();
  const monthDays = [];
  const allDays = [];
  for (const r of usageRows) {
    addUsage(overallT, r);
    allDays.push(r.day);
    if (r.day >= monthStart && r.day <= today) {
      addUsage(monthT, r);
      monthDays.push(r.day);
    }
    if (r.day === today) addUsage(todayT, r);
  }
  // Billing for days before usage tracking began still counts toward overall.
  const overallBillDays = [...new Set([...allDays, ...billingRows.map((b) => b.day)])];

  // Projection from the last seven *complete* days — today is partial.
  const recent = usageRows.filter((r) => r.day < today && r.day >= P.addDays(today, -7));
  const avgDailyInr = recent.length
    ? recent.reduce((a, r) => a + Number(r.estCostInr), 0) / recent.length
    : null;
  const avgDailySent = recent.length ? recent.reduce((a, r) => a + r.sent, 0) / recent.length : null;
  const daysLeft = P.daysInMonth(today) - Number(today.slice(8, 10));

  const chartFrom = P.addDays(today, -(Math.min(Math.max(days, 7), 400) - 1));
  const byDay = new Map(usageRows.map((r) => [r.day, r]));
  const firstTracked = usageRows[0]?.day ?? null;
  const chart = firstTracked
    ? P.daysBetween(chartFrom > firstTracked ? chartFrom : firstTracked, today).map((d) => {
        const r = byDay.get(d);
        const b = billing.get(d);
        return {
          day: d,
          sent: r?.sent ?? 0,
          verified: r?.verified ?? 0,
          blocked: r?.blocked ?? 0,
          failed: r?.failed ?? 0,
          free: r?.freeSms ?? 0,
          paid: r?.paidSms ?? 0,
          est_cost_inr: r ? Number(r.estCostInr) : 0,
          actual_cost_inr: b ? Number(b.netCostInr) : null,
        };
      })
    : [];

  const { latestExport } = ctx;

  const stale = (at, minutes) => !at || ctx.now - at > minutes * 60_000;

  return {
    configured: {
      usage: cfg.usageConfigured,
      billing: cfg.billingConfigured,
      project_id: cfg.projectId || null,
      billing_table: cfg.billingExportTable || null,
    },
    timezone: ctx.tz,
    today: today,
    month: today.slice(0, 7),
    pricing: {
      rate_usd: pricing.rateUsd,
      usd_to_inr: pricing.usdToInr,
      rate_inr: P.round4(pricing.rateUsd * pricing.usdToInr),
      free_per_day: pricing.freePerDay,
      priced_region: pricing.pricedRegion,
      source: pricing.source,
      updated_at: pricing.updatedAt,
      // What Google itself converted at, when billing is in a currency other than USD.
      billing_conversion_rate: num(billingRows.at(-1)?.conversionRate ?? null),
      reference_url: 'https://cloud.google.com/identity-platform/pricing',
    },
    sync: {
      interval_minutes: cfg.syncIntervalMinutes,
      running: Boolean(running),
      usage: {
        last_success_at: s.usageSyncedAt ?? null,
        last_attempt_at: s.usageAttemptAt ?? null,
        data_through: s.usageDataThrough ?? null,
        error: s.usageError ?? null,
        stale: cfg.usageConfigured && stale(s.usageSyncedAt, cfg.syncIntervalMinutes * 3),
      },
      billing: {
        last_success_at: s.billingSyncedAt ?? null,
        last_attempt_at: s.billingAttemptAt ?? null,
        latest_export_at: latestExport,
        error: s.billingError ?? null,
        // The export itself lags; flag it only when it is unusually far behind.
        delayed: cfg.billingConfigured && (!latestExport || stale(latestExport, 48 * 60)),
      },
    },
    tracking_since: firstTracked,
    totals: {
      today: { ...finishTotals(todayT), actual: actualTotals([today], billing, ctx) },
      month: { ...finishTotals(monthT), actual: actualTotals(monthDays, billing, ctx), days: monthDays.length },
      overall: { ...finishTotals(overallT), actual: actualTotals(overallBillDays, billing, ctx), days: allDays.length },
    },
    projection: {
      basis_days: recent.length,
      avg_daily_sent: avgDailySent == null ? null : Math.round(avgDailySent * 10) / 10,
      avg_daily_cost_inr: avgDailyInr == null ? null : P.round4(avgDailyInr),
      thirty_day_cost_inr: avgDailyInr == null ? null : P.round4(avgDailyInr * 30),
      month_end_cost_inr: avgDailyInr == null ? null : P.round4(monthT.est_cost_inr + avgDailyInr * daysLeft),
    },
    backend: {
      firebase_sign_ins_today: signInsToday,
      firebase_sign_ins_month: signInsMonth,
    },
    chart,
  };
}

/** The date-wise table, newest first, paginated. */
async function history({ skip, take, from, to }) {
  const ctx = await context();
  const where = {
    ...(from || to ? { day: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
  };
  const [rows, total, agg] = await Promise.all([
    prisma.smsUsageDay.findMany({ where, orderBy: { day: 'desc' }, skip, take }),
    prisma.smsUsageDay.count({ where }),
    prisma.smsUsageDay.aggregate({
      where,
      _sum: { sent: true, freeSms: true, paidSms: true, estCostInr: true },
    }),
  ]);
  const bills = await prisma.smsBillingDay.findMany({ where: { day: { in: rows.map((r) => r.day) } } });
  const billing = new Map(bills.map((b) => [b.day, b]));

  return {
    items: rows.map((r) => serializeDay(r, billing.get(r.day), ctx)),
    total,
    totals: {
      sent: agg._sum.sent ?? 0,
      free: agg._sum.freeSms ?? 0,
      paid: agg._sum.paidSms ?? 0,
      est_cost_inr: num(agg._sum.estCostInr) ?? 0,
    },
  };
}

/**
 * Changes the price used for estimates.
 *
 * `applyTo: 'recent'` re-prices only the days the next sync re-reads anyway
 * (closed history keeps the rate it was estimated at); `'all'` re-prices
 * every stored day — for correcting a rate that was wrong all along.
 */
async function updatePricing({ rateUsd, usdToInr, freePerDay, applyTo = 'recent' }) {
  const bad = {};
  const check = (name, v, { min, max, int }) => {
    if (v === undefined) return;
    if (v === null) return; // null clears the override back to the default
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) {
      bad[name] = `Must be ${int ? 'a whole number ' : ''}between ${min} and ${max}.`;
    }
  };
  check('rate_usd', rateUsd, { min: 0, max: 5 });
  check('usd_to_inr', usdToInr, { min: 1, max: 1000 });
  check('free_per_day', freePerDay, { min: 0, max: 100_000, int: true });
  if (!['recent', 'all'].includes(applyTo)) bad.apply_to = 'Must be "recent" or "all".';
  if (Object.keys(bad).length) throw errors.validation(bad);

  const data = { pricingUpdatedAt: new Date() };
  if (rateUsd !== undefined) data.rateUsd = rateUsd === null ? null : Number(rateUsd);
  if (usdToInr !== undefined) data.usdToInr = usdToInr === null ? null : Number(usdToInr);
  if (freePerDay !== undefined) data.freePerDay = freePerDay === null ? null : Number(freePerDay);
  const saved = await saveState(data);
  const pricing = pricingFrom(saved);

  const tz = cfg.timezone;
  const firstDay = P.addDays(P.dayOf(new Date(), tz), -(Math.max(1, cfg.usageLookbackDays) - 1));
  const rows = await prisma.smsUsageDay.findMany({
    where: applyTo === 'all' ? {} : { day: { gte: firstDay } },
  });
  await prisma.$transaction(
    rows.map((r) =>
      prisma.smsUsageDay.update({
        where: { day: r.day },
        data: usageRowData(r.day, { ...r, regions: r.regions ?? {} }, pricing),
      })
    )
  );

  emitToAdmin('admin:sms_usage_synced', { at: new Date().toISOString() });
  return { pricing, repriced_days: rows.length };
}

module.exports = { summary, history, sync, scheduleSync, updatePricing, _internal: { toInr, billingStatus } };
