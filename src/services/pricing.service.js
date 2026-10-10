'use strict';

const prisma = require('../config/prisma');
const { errors, AppError } = require('../utils/errors');
const {
  emitToUser,
  emitToUsers,
  emitToPresenceWatchers,
  emitToAdmin,
} = require('../sockets/bus');

/**
 * Level-based call pricing for women.
 *
 * Every woman has two levels, voice and video, each from 1 (Starter) to 6
 * (Elite), earned separately from that call type's completed, billed call
 * time and the number of distinct men who have paid for one. Her price per
 * minute is her level's rate on the ladder. Both requirements must be met to
 * reach a level, and levels only rise — an admin can set one by hand, and
 * the next qualifying call can still raise it.
 *
 * **The ladder is admin-editable** (`CallLevel` rows) and cached here, so a
 * feed of twenty cards can quote twenty prices without twenty queries. The
 * cache is reloaded after every admin change and every minute besides, which
 * is what keeps a second instance in step.
 *
 * **Counting is idempotent.** A call is counted inside one transaction that
 * first claims it (`Call.statsCountedAt`, compare-and-set) — a retried or
 * duplicated end event finds the claim taken and counts nothing — and a man
 * counts towards her unique callers through an insert into `EarnerCaller`,
 * whose primary key skips him the second time.
 *
 * Men pay men's calls at the flat `BASE_RATE`, and women's calls with each
 * other are free — see `utils/callPricing`, which asks this service only for
 * a woman's rate.
 */

/** A 400 with a machine-readable code the admin panel can switch on. */
const invalid = (message, code) => new AppError(message, { status: 400, code });

const TYPES = ['voice', 'video'];
const LEVELS = 6;
const HOUR = 3600;

/** The launch ladder — also the fallback should the table ever be empty. */
const DEFAULT_LADDER = {
  voice: [
    { level: 1, name: 'Starter', minSeconds: 0, minUniqueCallers: 0, ratePerMinute: 3 },
    { level: 2, name: 'Silver', minSeconds: 3 * HOUR, minUniqueCallers: 5, ratePerMinute: 4 },
    { level: 3, name: 'Gold', minSeconds: 10 * HOUR, minUniqueCallers: 15, ratePerMinute: 5 },
    { level: 4, name: 'Platinum', minSeconds: 25 * HOUR, minUniqueCallers: 30, ratePerMinute: 6 },
    { level: 5, name: 'Diamond', minSeconds: 50 * HOUR, minUniqueCallers: 60, ratePerMinute: 7 },
    { level: 6, name: 'Elite', minSeconds: 100 * HOUR, minUniqueCallers: 100, ratePerMinute: 8 },
  ],
  video: [
    { level: 1, name: 'Starter', minSeconds: 0, minUniqueCallers: 0, ratePerMinute: 7 },
    { level: 2, name: 'Silver', minSeconds: 2 * HOUR, minUniqueCallers: 3, ratePerMinute: 9 },
    { level: 3, name: 'Gold', minSeconds: 6 * HOUR, minUniqueCallers: 10, ratePerMinute: 12 },
    { level: 4, name: 'Platinum', minSeconds: 15 * HOUR, minUniqueCallers: 20, ratePerMinute: 15 },
    { level: 5, name: 'Diamond', minSeconds: 30 * HOUR, minUniqueCallers: 40, ratePerMinute: 18 },
    { level: 6, name: 'Elite', minSeconds: 60 * HOUR, minUniqueCallers: 75, ratePerMinute: 20 },
  ],
};
const DEFAULT_SHARE = 0.3;

const cache = {
  ladder: DEFAULT_LADDER,
  earnerShare: DEFAULT_SHARE,
  loadedAt: null,
};

// ── The ladder ──────────────────────────────────────────────────────────────

/** Reads the ladder and settings into the cache. Safe to call any time. */
async function load() {
  const [rows, settings] = await Promise.all([
    prisma.callLevel.findMany({ orderBy: [{ type: 'asc' }, { level: 'asc' }] }),
    prisma.pricingSettings.findUnique({ where: { id: 1 } }),
  ]);
  const ladder = {};
  for (const type of TYPES) {
    const ofType = rows
      .filter((r) => r.type === type)
      .map((r) => ({
        level: r.level,
        name: r.name,
        minSeconds: r.minSeconds,
        minUniqueCallers: r.minUniqueCallers,
        ratePerMinute: Number(r.ratePerMinute),
      }));
    ladder[type] = ofType.length === LEVELS ? ofType : DEFAULT_LADDER[type];
  }
  cache.ladder = ladder;
  cache.earnerShare = settings ? Number(settings.earnerShare) : DEFAULT_SHARE;
  cache.loadedAt = new Date();
  return cache;
}

let refreshTimer = null;
/** Loads now and every minute after — call once at boot. */
async function start() {
  await load().catch((err) => console.error('[pricing] could not load the ladder', err));
  if (!refreshTimer) {
    refreshTimer = setInterval(
      () => load().catch((err) => console.error('[pricing] ladder refresh failed', err)),
      60_000
    );
    refreshTimer.unref?.();
  }
}

function ladderFor(type) {
  return cache.ladder[type] ?? DEFAULT_LADDER[type];
}

function clampLevel(level) {
  const n = Number(level);
  if (!Number.isInteger(n)) return 1;
  return Math.min(LEVELS, Math.max(1, n));
}

function levelInfo(type, level) {
  return ladderFor(type)[clampLevel(level) - 1];
}

/** A woman's price per minute for [type] at [level]. */
function rateForLevel(type, level) {
  return levelInfo(type, level).ratePerMinute;
}

/** Her level for [type], from her profile row. */
function levelOf(profile, type) {
  return clampLevel(type === 'voice' ? profile?.voiceLevel : profile?.videoLevel);
}

/** The highest level whose every requirement the totals meet. */
function qualifiedLevel(type, { seconds, uniqueCallers }) {
  let best = 1;
  for (const step of ladderFor(type)) {
    if (seconds >= step.minSeconds && uniqueCallers >= step.minUniqueCallers) best = step.level;
  }
  return best;
}

/** The earner's share of a call, as a fraction — 0.3 is 30%. */
function earnerShare() {
  return cache.earnerShare;
}

// ── Counting a call ─────────────────────────────────────────────────────────

/**
 * Adds a finished call to the earner's statistics and raises her level if it
 * now qualifies. Idempotent: counts each call once, however often it is
 * called for it.
 *
 * Only a call that was actually paid for counts — ended, money charged, an
 * earner and a payer. Failed, unanswered, cancelled and free calls never
 * reach the charge, so they never reach here.
 *
 * Returns the level change, or null.
 */
async function recordCall({ call, earnerId, payerId }) {
  if (!earnerId || !payerId || call.status !== 'ended') return null;
  if (!(Number(call.amountSpent) > 0)) return null;
  const type = call.type;
  const seconds = Math.max(0, Number(call.durationSeconds) || 0);

  const change = await prisma.$transaction(async (tx) => {
    // The claim. Whoever sets it counts the call; everyone after does nothing.
    const claimed = await tx.call.updateMany({
      where: { id: call.id, statsCountedAt: null },
      data: { statsCountedAt: new Date() },
    });
    if (claimed.count === 0) return null;

    // He counts once, ever, per call type — the primary key decides.
    const added = await tx.earnerCaller.createMany({
      data: [{ earnerId, callerId: payerId, type, firstCallId: call.id }],
      skipDuplicates: true,
    });

    const stats = await tx.earnerCallStats.upsert({
      where: { userId_type: { userId: earnerId, type } },
      create: {
        userId: earnerId,
        type,
        billableSeconds: seconds,
        uniqueCallers: added.count,
        countedCalls: 1,
      },
      update: {
        billableSeconds: { increment: seconds },
        uniqueCallers: { increment: added.count },
        countedCalls: { increment: 1 },
      },
    });

    const target = qualifiedLevel(type, {
      seconds: stats.billableSeconds,
      uniqueCallers: stats.uniqueCallers,
    });
    return raiseLevel(tx, {
      userId: earnerId,
      type,
      target,
      source: 'auto',
      callId: call.id,
    });
  });

  if (change) announce(change);
  return change;
}

/**
 * Moves her [type] level to [target] if that is higher — a compare-and-set,
 * so two calls ending together cannot both record the same upgrade.
 */
async function raiseLevel(tx, { userId, type, target, source, reason, actor, callId }) {
  const field = type === 'voice' ? 'voiceLevel' : 'videoLevel';
  const profile = await tx.userProfile.findUnique({
    where: { userId },
    select: { [field]: true },
  });
  if (!profile) return null;
  const from = clampLevel(profile[field]);
  if (target <= from) return null;

  const { count } = await tx.userProfile.updateMany({
    where: { userId, [field]: from },
    data: { [field]: target },
  });
  if (count === 0) return null;

  return tx.earnerLevelChange.create({
    data: {
      userId,
      type,
      fromLevel: from,
      toLevel: target,
      fromName: levelInfo(type, from).name,
      toName: levelInfo(type, target).name,
      fromRate: rateForLevel(type, from),
      toRate: rateForLevel(type, target),
      source,
      reason: reason ?? null,
      actor: actor ?? null,
      callId: callId ?? null,
    },
  });
}

/**
 * Tells her, and everyone who can see her right now, that her price moved —
 * the same audience as a presence change. Her own app refreshes its level
 * screen; theirs re-price her card without a reload.
 */
function announce(change) {
  const payload = {
    user_id: change.userId,
    type: change.type,
    level: change.toLevel,
    level_name: levelInfo(change.type, change.toLevel).name,
    rate_per_minute: Number(change.toRate),
  };
  emitToUser(change.userId, 'levels:updated', payload);
  // The admin panel's Pricing & Levels refreshes on this.
  emitToAdmin('admin:level_changed', {
    ...payload,
    from_level: change.fromLevel,
    source: change.source,
  });
  emitToPresenceWatchers(change.userId, 'profile:rates_changed', payload);
  // Lazy: relationship.service pulls in a good deal, and this runs rarely.
  require('./relationship.service')
    .conversationPeerIdsFor(change.userId)
    .then((peers) => {
      if (peers.size > 0) emitToUsers([...peers], 'profile:rates_changed', payload);
    })
    .catch((err) => console.error('[pricing] rate change not announced', err));

  if (change.toLevel > change.fromLevel) {
    require('./notification.service')
      .notify({
        userId: change.userId,
        kind: 'earning',
        title: `You reached ${payload.level_name}!`,
        body: `Your ${change.type} calls are now ₹${payload.rate_per_minute}/min.`,
        data: { type: change.type, level: change.toLevel },
      })
      .catch((err) => console.error('[pricing] level notification failed', err));
  }
}

// ── Reading ─────────────────────────────────────────────────────────────────

/**
 * Her two levels, with everything the progress screen shows: where she is,
 * what it pays, her totals, and what the next level needs.
 */
async function earnerLevels(userId) {
  const [profile, stats] = await Promise.all([
    prisma.userProfile.findUnique({
      where: { userId },
      select: { voiceLevel: true, videoLevel: true },
    }),
    prisma.earnerCallStats.findMany({ where: { userId } }),
  ]);
  const out = {};
  for (const type of TYPES) {
    const row = stats.find((s) => s.type === type);
    const seconds = row?.billableSeconds ?? 0;
    const uniqueCallers = row?.uniqueCallers ?? 0;
    const level = levelOf(profile, type);
    const current = levelInfo(type, level);
    const next = level < LEVELS ? levelInfo(type, level + 1) : null;
    out[type] = {
      level,
      name: current.name,
      rate_per_minute: current.ratePerMinute,
      billable_seconds: seconds,
      unique_callers: uniqueCallers,
      counted_calls: row?.countedCalls ?? 0,
      next: next && {
        level: next.level,
        name: next.name,
        rate_per_minute: next.ratePerMinute,
        min_seconds: next.minSeconds,
        min_unique_callers: next.minUniqueCallers,
        remaining_seconds: Math.max(0, next.minSeconds - seconds),
        remaining_unique_callers: Math.max(0, next.minUniqueCallers - uniqueCallers),
      },
      ladder: ladderFor(type).map(serializeStep),
    };
  }
  return out;
}

function serializeStep(step) {
  return {
    level: step.level,
    name: step.name,
    min_seconds: step.minSeconds,
    min_unique_callers: step.minUniqueCallers,
    rate_per_minute: step.ratePerMinute,
  };
}

// ── Admin ───────────────────────────────────────────────────────────────────

function settingsView() {
  return {
    earner_share: cache.earnerShare,
    ladder: { voice: ladderFor('voice').map(serializeStep), video: ladderFor('video').map(serializeStep) },
  };
}

/**
 * Replaces one call type's ladder. Six levels; Starter needs nothing;
 * requirements and prices never go down from one level to the next.
 *
 * Lowered requirements can mean women who already qualify for more — they
 * are raised straight away, recorded as automatic upgrades.
 */
async function updateLadder(type, steps) {
  if (!TYPES.includes(type)) throw invalid('Unknown call type.', 'BAD_CALL_TYPE');
  if (!Array.isArray(steps) || steps.length !== LEVELS) {
    throw invalid(`A ladder has exactly ${LEVELS} levels.`, 'BAD_LADDER');
  }
  const clean = steps
    .map((s, i) => ({
      level: i + 1,
      name: String(s.name ?? '').trim(),
      minSeconds: Math.round(Number(s.min_seconds)),
      minUniqueCallers: Math.round(Number(s.min_unique_callers)),
      ratePerMinute: Math.round(Number(s.rate_per_minute) * 100) / 100,
    }));
  for (const [i, s] of clean.entries()) {
    const label = `Level ${s.level}`;
    if (!s.name || s.name.length > 30) throw invalid(`${label} needs a name.`, 'BAD_LADDER');
    if (![s.minSeconds, s.minUniqueCallers].every((n) => Number.isInteger(n) && n >= 0)) {
      throw invalid(`${label}: requirements must be whole, non-negative numbers.`, 'BAD_LADDER');
    }
    if (!(s.ratePerMinute > 0 && s.ratePerMinute <= 1000)) {
      throw invalid(`${label}: the price must be between ₹0.01 and ₹1000.`, 'BAD_LADDER');
    }
    const prev = clean[i - 1];
    if (!prev && (s.minSeconds !== 0 || s.minUniqueCallers !== 0)) {
      throw invalid('Starter must need nothing — every woman begins there.', 'BAD_LADDER');
    }
    if (
      prev &&
      (s.minSeconds < prev.minSeconds ||
        s.minUniqueCallers < prev.minUniqueCallers ||
        s.ratePerMinute < prev.ratePerMinute)
    ) {
      throw invalid(
        `${label} cannot need less, or cost less, than level ${prev.level}.`,
        'BAD_LADDER'
      );
    }
  }

  await prisma.$transaction(
    clean.map((s) =>
      prisma.callLevel.upsert({
        where: { type_level: { type, level: s.level } },
        create: { type, ...s },
        update: { name: s.name, minSeconds: s.minSeconds, minUniqueCallers: s.minUniqueCallers, ratePerMinute: s.ratePerMinute },
      })
    )
  );
  await load();
  const raised = await recomputeAll(type);
  return { ...settingsView(), raised };
}

/** Raises every woman whose totals now qualify for more — after a ladder edit. */
async function recomputeAll(type) {
  const rows = await prisma.earnerCallStats.findMany({ where: { type } });
  let raised = 0;
  for (const row of rows) {
    const target = qualifiedLevel(type, {
      seconds: row.billableSeconds,
      uniqueCallers: row.uniqueCallers,
    });
    const change = await prisma.$transaction((tx) =>
      raiseLevel(tx, {
        userId: row.userId,
        type,
        target,
        source: 'auto',
        reason: 'Level requirements changed',
      })
    );
    if (change) {
      raised += 1;
      announce(change);
    }
  }
  return raised;
}

/** Sets the earner's share — a fraction between 0 and 1. */
async function updateEarnerShare(share) {
  const value = Number(share);
  if (!(value >= 0 && value <= 1)) {
    throw invalid('The earner share must be between 0% and 100%.', 'BAD_SHARE');
  }
  const rounded = Math.round(value * 10_000) / 10_000;
  await prisma.pricingSettings.upsert({
    where: { id: 1 },
    create: { id: 1, earnerShare: rounded },
    update: { earnerShare: rounded },
  });
  await load();
  return settingsView();
}

/**
 * An admin sets her level by hand — up or down. Recorded in her history and
 * the audit log (by the route). The next qualifying call can still raise it.
 */
async function setLevel(userId, { type, level, reason, actor }) {
  if (!TYPES.includes(type)) throw invalid('Unknown call type.', 'BAD_CALL_TYPE');
  const target = Number(level);
  if (!Number.isInteger(target) || target < 1 || target > LEVELS) {
    throw invalid(`The level must be 1 to ${LEVELS}.`, 'BAD_LEVEL');
  }
  if (!reason || !String(reason).trim()) {
    throw invalid('Say why — it goes in the audit log.', 'REASON_REQUIRED');
  }
  const field = type === 'voice' ? 'voiceLevel' : 'videoLevel';
  const profile = await prisma.userProfile.findUnique({
    where: { userId },
    select: { gender: true, [field]: true },
  });
  if (!profile) throw errors.notFound('User');
  if (profile.gender !== 'female') {
    throw invalid('Only women have call levels.', 'NOT_AN_EARNER');
  }
  const from = clampLevel(profile[field]);
  if (from === target) return { change: null, levels: await earnerLevels(userId) };

  const change = await prisma.$transaction(async (tx) => {
    await tx.userProfile.update({ where: { userId }, data: { [field]: target } });
    return tx.earnerLevelChange.create({
      data: {
        userId,
        type,
        fromLevel: from,
        toLevel: target,
        fromName: levelInfo(type, from).name,
        toName: levelInfo(type, target).name,
        fromRate: rateForLevel(type, from),
        toRate: rateForLevel(type, target),
        source: 'admin',
        reason: String(reason).trim().slice(0, 500),
        actor: actor ?? null,
      },
    });
  });
  announce(change);
  return { change: serializeChange(change), levels: await earnerLevels(userId) };
}

function serializeChange(c) {
  return {
    id: c.id,
    user_id: c.userId,
    type: c.type,
    from_level: c.fromLevel,
    to_level: c.toLevel,
    from_name: c.fromName,
    to_name: c.toName,
    from_rate: Number(c.fromRate),
    to_rate: Number(c.toRate),
    source: c.source,
    reason: c.reason,
    actor: c.actor,
    call_id: c.callId,
    created_at: c.createdAt.toISOString(),
  };
}

module.exports = {
  TYPES,
  LEVELS,
  DEFAULT_LADDER,
  start,
  load,
  ladderFor,
  levelInfo,
  levelOf,
  rateForLevel,
  qualifiedLevel,
  earnerShare,
  recordCall,
  earnerLevels,
  settingsView,
  updateLadder,
  updateEarnerShare,
  setLevel,
  serializeChange,
};
