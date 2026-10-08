'use strict';

/**
 * Firebase SMS pricing and billing-day arithmetic.
 *
 * Pure functions, no I/O, so the numbers the admin panel shows can be checked
 * by a test rather than trusted.
 *
 * The rule, from Identity Platform's pricing page: the first `freePerDay` SMS
 * a **project** sends in a billing day are not billed — one allowance for the
 * whole project, not one per user or per number — and every SMS after that
 * costs the destination country's rate. India is $0.07.
 *
 * Example: 100 SMS in a day → 10 free, 90 paid, 90 × $0.07 = $6.30,
 * × ₹90/$ = ₹567.00.
 */

/** Four decimal places, the precision money is stored at. */
function round4(n) {
  return Math.round((Number(n) + Number.EPSILON) * 10_000) / 10_000;
}

/**
 * Prices one billing day.
 *
 * `regions` is `{ IN: { sent } , US: { sent } }` as Monitoring reports it.
 * SMS with no region label are treated as the priced region — the label is
 * always present in practice, and dropping them would under-count cost.
 *
 * The free allowance is applied to the priced region first. Google applies it
 * to the first ten SMS sent, in order, and a daily total cannot say which
 * those were; for an India-only app the two are identical, and anything sent
 * elsewhere is surfaced as `unpricedSms` rather than priced at a guessed rate.
 */
function priceDay({ sent, regions }, { rateUsd, usdToInr, freePerDay, pricedRegion = 'IN' }) {
  const total = Math.max(0, Math.trunc(sent || 0));

  let labelled = 0;
  let pricedSent = 0;
  for (const [code, r] of Object.entries(regions ?? {})) {
    const n = Math.max(0, Math.trunc(r?.sent || 0));
    labelled += n;
    if (code.toUpperCase() === pricedRegion) pricedSent += n;
  }
  // Anything Monitoring did not label with a region.
  pricedSent += Math.max(0, total - labelled);
  pricedSent = Math.min(pricedSent, total);

  const freeSms = Math.min(Math.max(0, Math.trunc(freePerDay)), total);
  const freeOnPriced = Math.min(freeSms, pricedSent);
  const paidSms = total - freeSms;
  const paidPriced = pricedSent - freeOnPriced;
  const unpricedSms = paidSms - paidPriced;

  const estCostUsd = round4(paidPriced * Number(rateUsd));
  const estCostInr = round4(estCostUsd * Number(usdToInr));

  return { freeSms, paidSms, unpricedSms, estCostUsd, estCostInr };
}

// ── Billing days ────────────────────────────────────────────────────────────
//
// A billing day is a calendar date in a named time zone (Google bills on US
// Pacific time). Represented everywhere as `YYYY-MM-DD` — a string, because a
// JS Date is an instant and an instant has no "day" without a zone.

const formatters = new Map();
function formatter(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(
      timeZone,
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      })
    );
  }
  return formatters.get(timeZone);
}

function partsIn(date, timeZone) {
  const out = {};
  for (const p of formatter(timeZone).formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out;
}

/** The billing day an instant falls in. */
function dayOf(date, timeZone) {
  const p = partsIn(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** How far `timeZone` is ahead of UTC at `date`, in ms. */
function offsetMs(date, timeZone) {
  const p = partsIn(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant a billing day starts. Correct across DST changes. */
function startOfDay(day, timeZone) {
  const [y, m, d] = day.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  // Two passes: the offset at the guess can differ from the offset at the
  // answer when a DST change falls between them.
  let at = guess - offsetMs(new Date(guess), timeZone);
  at = guess - offsetMs(new Date(at), timeZone);
  return new Date(at);
}

/** `2026-10-31` + 1 → `2026-11-01`. Calendar arithmetic, no zone involved. */
function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Every day from `from` to `to`, inclusive. */
function daysBetween(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

function daysInMonth(day) {
  const [y, m] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

module.exports = {
  priceDay,
  round4,
  dayOf,
  startOfDay,
  addDays,
  daysBetween,
  daysInMonth,
};
