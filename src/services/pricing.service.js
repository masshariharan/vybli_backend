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
 * Level-based call pricing.
 *
 * Everyone who can be paid to be called has two levels, voice and video,
 * each from 1 (Starter) to 6 (Elite), earned separately from that call
 * type's completed, billed call time and the number of distinct men who have
 * paid for one. Their price per minute is their level's rate on the ladder.
 * Both requirements must be met to reach a level, and levels only rise — an
 * admin can set one by hand, and the next qualifying call can still raise it.
 *
 * **Two audiences, two ladders.** Women are priced by the women's ladder on
 * every call a man pays for with them, and earn a share of it. Men are
 * priced by the men's ladder on calls from other men — the caller pays the
 * answering man's level price — and Vybli keeps all of it: no man earns. Each
 * ladder is admin-editable on its own (`CallLevel` rows, keyed by audience).
 * Two women call free; a man and a woman are always priced by her.
 *
 * **The ladders are cached here**, so a feed of twenty cards can quote twenty
 * prices without twenty queries. The cache is reloaded after every admin
 * change and every minute besides, which keeps a second instance in step.
 *
 * **Counting is idempotent.** A call is counted inside one transaction that
 * first claims it (`Call.statsCountedAt`, compare-and-set) — a retried or
 * duplicated end event finds the claim taken and counts nothing — and a
 * paying man counts towards someone's unique callers through an insert into
 * `EarnerCaller`, whose primary key skips him the second time.
 */

/** A 400 with a machine-readable code the admin panel can switch on. */
const invalid = (message, code) => new AppError(message, { status: 400, code });

const AUDIENCES = ['female', 'male'];
const TYPES = ['voice', 'video'];
const LEVELS = 6;
const HOUR = 3600;

/** The launch ladder for both audiences — also the fallback for an empty table. */
const LAUNCH_LADDER = {
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
const DEFAULT_LADDER = { female: LAUNCH_LADDER, male: LAUNCH_LADDER };
const DEFAULT_SHARE = 0.3;

const cache = {
  ladder: DEFAULT_LADDER,
  earnerShare: DEFAULT_SHARE,
  loadedAt: null,
};

// ── The ladders ─────────────────────────────────────────────────────────────

/** Reads the ladders and settings into the cache. Safe to call any time. */
async function load() {
  const [rows, settings] = await Promise.all([
    prisma.callLevel.findMany({
      orderBy: [{ audience: 'asc' }, { type: 'asc' }, { level: 'asc' }],
    }),
    prisma.pricingSettings.findUnique({ where: { id: 1 } }),
  ]);
  const ladder = {};
  for (const audience of AUDIENCES) {
    ladder[audience] = {};
    for (const type of TYPES) {
      const steps = rows
        .filter((r) => r.audience === audience && r.type === type)
        .map((r) => ({
          level: r.level,
          name: r.name,
          minSeconds: r.minSeconds,
          minUniqueCallers: r.minUniqueCallers,
          ratePerMinute: Number(r.ratePerMinute),
        }));
      ladder[audience][type] =
        steps.length === LEVELS ? steps : DEFAULT_LADDER[audience][type];
    }
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

/** Which ladder prices this person: `female` or `male`, by their gender. */
function audienceOf(profile) {
  return profile?.gender === 'male' ? 'male' : 'female';
}

function checkAudience(audience) {
  if (!AUDIENCES.includes(audience)) throw invalid('Unknown audience.', 'BAD_AUDIENCE');
}

function ladderFor(audience, type) {
  return cache.ladder[audience]?.[type] ?? DEFAULT_LADDER.female[type];
}

function clampLevel(level) {
  const n = Number(level);
  if (!Number.isInteger(n)) return 1;
  return Math.min(LEVELS, Math.max(1, n));
}

function levelInfo(audience, type, level) {
  return ladderFor(audience, type)[clampLevel(level) - 1];
}

/** The price per minute for [type] at [level] on [audience]'s ladder. */
function rateForLevel(audience, type, level) {
  return levelInfo(audience, type, level).ratePerMinute;
}

/** This person's own price for [type] — their level, on their ladder. */
function rateFor(profile, type) {
  return rateForLevel(audienceOf(profile), type, levelOf(profile, type));
}

/** Their level for [type], from their profile row. */
function levelOf(profile, type) {
  return clampLevel(type === 'voice' ? profile?.voiceLevel : profile?.videoLevel);
}

/** The highest level whose every requirement the totals meet. */
function qualifiedLevel(audience, type, { seconds, uniqueCallers }) {
  let best = 1;
  for (const step of ladderFor(audience, type)) {
    if (seconds >= step.minSeconds && uniqueCallers >= step.minUniqueCallers) best = step.level;
  }
  return best;
}

/** The earner's share of a call, as a fraction — 0.3 is 30%. Women only. */
function earnerShare() {
  return cache.earnerShare;
}

// ── Counting a call ─────────────────────────────────────────────────────────

/**
 * Adds a finished call to the statistics of the person it was priced by —
 * [holderId]: the woman on a call between a man and a woman, the man who
 * answered on a call between two men — and raises their level if it now
 * qualifies. Idempotent: counts each call once, however often it is called.
 *
 * Only a call that was actually paid for counts — ended, money charged, and
 * a payer who is not the holder. Failed, unanswered, cancelled and free
 * calls never reach the charge, so they never reach here.
 *
 * Returns the level change, or null.
 */
async function recordCall({ call, holderId, payerId, audience }) {
  if (!holderId || !payerId || holderId === payerId || call.status !== 'ended') return null;
  if (!(Number(call.amountSpent) > 0)) return null;
  checkAudience(audience);
  const type = call.type;
  const seconds = Math.max(0, Number(call.durationSeconds) || 0);

  const change = await prisma.$transaction(async (tx) => {
    // The claim. Whoever sets it counts the call; everyone after does nothing.
    const claimed = await tx.call.updateMany({
      where: { id: call.id, statsCountedAt: null },
      data: { statsCountedAt: new Date() },
    });
    if (claimed.count === 0) return null;

    // A paying man counts once, ever, per call type — the primary key decides.
    const added = await tx.earnerCaller.createMany({
      data: [{ earnerId: holderId, callerId: payerId, type, firstCallId: call.id }],
      skipDuplicates: true,
    });

    const stats = await tx.earnerCallStats.upsert({
      where: { userId_type: { userId: holderId, type } },
      create: {
        userId: holderId,
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

    const target = qualifiedLevel(audience, type, {
      seconds: stats.billableSeconds,
      uniqueCallers: stats.uniqueCallers,
    });
    return raiseLevel(tx, {
      userId: holderId,
      audience,
      type,
      target,
      source: 'auto',
      callId: call.id,
    });
  });

  if (change) announce(change, audience);
  return change;
}

/**
 * Moves their [type] level to [target] if that is higher — a compare-and-set,
 * so two calls ending together cannot both record the same upgrade.
 */
async function raiseLevel(tx, { userId, audience, type, target, source, reason, actor, callId }) {
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
    data: changeData({ userId, audience, type, from, to: target, source, reason, actor, callId }),
  });
}

function changeData({ userId, audience, type, from, to, source, reason, actor, callId }) {
  return {
    userId,
    audience,
    type,
    fromLevel: from,
    toLevel: to,
    fromName: levelInfo(audience, type, from).name,
    toName: levelInfo(audience, type, to).name,
    fromRate: rateForLevel(audience, type, from),
    toRate: rateForLevel(audience, type, to),
    source,
    reason: reason ?? null,
    actor: actor ?? null,
    callId: callId ?? null,
  };
}

/**
 * Tells them, and everyone who can see them right now, that their price
 * moved — the same audience as a presence change. Their own app refreshes
 * its level screen; everyone else's re-prices their card without a reload.
 */
function announce(change, audience) {
  const payload = {
    user_id: change.userId,
    type: change.type,
    level: change.toLevel,
    level_name: change.toName,
    rate_per_minute: Number(change.toRate),
  };
  emitToUser(change.userId, 'levels:updated', payload);
  // The admin panel's Pricing & Levels refreshes on this.
  emitToAdmin('admin:level_changed', {
    ...payload,
    audience,
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
        kind: audience === 'female' ? 'earning' : 'system',
        title: `You reached ${payload.level_name}!`,
        body: `Your ${change.type} calls are now ₹${payload.rate_per_minute}/min.`,
        data: { type: change.type, level: change.toLevel },
      })
      .catch((err) => console.error('[pricing] level notification failed', err));
  }
}

// ── Reading ─────────────────────────────────────────────────────────────────

/**
 * Their two levels, with everything the progress screen shows: where they
 * are, what it costs callers, their totals, and what the next level needs.
 */
async function earnerLevels(userId) {
  const [profile, stats] = await Promise.all([
    prisma.userProfile.findUnique({
      where: { userId },
      select: { gender: true, voiceLevel: true, videoLevel: true },
    }),
    prisma.earnerCallStats.findMany({ where: { userId } }),
  ]);
  if (!profile?.gender) return null;
  const audience = audienceOf(profile);
  const out = { audience };
  for (const type of TYPES) {
    const row = stats.find((s) => s.type === type);
    const seconds = row?.billableSeconds ?? 0;
    const uniqueCallers = row?.uniqueCallers ?? 0;
    const level = levelOf(profile, type);
    const current = levelInfo(audience, type, level);
    const next = level < LEVELS ? levelInfo(audience, type, level + 1) : null;
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
      ladder: ladderFor(audience, type).map(serializeStep),
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
  const ladder = {};
  for (const audience of AUDIENCES) {
    ladder[audience] = {};
    for (const type of TYPES) {
      ladder[audience][type] = ladderFor(audience, type).map(serializeStep);
    }
  }
  return { earner_share: cache.earnerShare, ladder };
}

/**
 * Replaces one audience's ladder for one call type. Six levels; Starter
 * needs nothing; requirements and prices never go down level to level.
 *
 * Lowered requirements can mean people who already qualify for more — they
 * are raised straight away, recorded as automatic upgrades.
 */
async function updateLadder(audience, type, steps) {
  checkAudience(audience);
  if (!TYPES.includes(type)) throw invalid('Unknown call type.', 'BAD_CALL_TYPE');
  if (!Array.isArray(steps) || steps.length !== LEVELS) {
    throw invalid(`A ladder has exactly ${LEVELS} levels.`, 'BAD_LADDER');
  }
  const clean = steps.map((s, i) => ({
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
      throw invalid('Starter must need nothing — everyone begins there.', 'BAD_LADDER');
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
        where: { audience_type_level: { audience, type, level: s.level } },
        create: { audience, type, ...s },
        update: {
          name: s.name,
          minSeconds: s.minSeconds,
          minUniqueCallers: s.minUniqueCallers,
          ratePerMinute: s.ratePerMinute,
        },
      })
    )
  );
  await load();
  const raised = await recomputeAll(audience, type);
  return { ...settingsView(), raised };
}

/** Raises everyone on [audience]'s ladder whose totals now qualify for more. */
async function recomputeAll(audience, type) {
  const rows = await prisma.earnerCallStats.findMany({
    where: { type, user: { profile: { gender: audience } } },
  });
  let raised = 0;
  for (const row of rows) {
    const target = qualifiedLevel(audience, type, {
      seconds: row.billableSeconds,
      uniqueCallers: row.uniqueCallers,
    });
    const change = await prisma.$transaction((tx) =>
      raiseLevel(tx, {
        userId: row.userId,
        audience,
        type,
        target,
        source: 'auto',
        reason: 'Level requirements changed',
      })
    );
    if (change) {
      raised += 1;
      announce(change, audience);
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
 * An admin sets someone's level by hand — up or down. Recorded in their
 * history and the audit log (by the route). The next qualifying call can
 * still raise it.
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
  if (!profile.gender) throw invalid('This account has no gender yet, so no ladder.', 'NO_LADDER');
  const audience = audienceOf(profile);
  const from = clampLevel(profile[field]);
  if (from === target) return { change: null, levels: await earnerLevels(userId) };

  const change = await prisma.$transaction(async (tx) => {
    await tx.userProfile.update({ where: { userId }, data: { [field]: target } });
    return tx.earnerLevelChange.create({
      data: changeData({
        userId,
        audience,
        type,
        from,
        to: target,
        source: 'admin',
        reason: String(reason).trim().slice(0, 500),
        actor,
      }),
    });
  });
  announce(change, audience);
  return { change: serializeChange(change), levels: await earnerLevels(userId) };
}

function serializeChange(c) {
  return {
    id: c.id,
    user_id: c.userId,
    audience: c.audience,
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
  AUDIENCES,
  TYPES,
  LEVELS,
  DEFAULT_LADDER,
  start,
  load,
  audienceOf,
  ladderFor,
  levelInfo,
  levelOf,
  rateForLevel,
  rateFor,
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
