'use strict';

const prisma = require('../../config/prisma');
const avatarCatalog = require('../../config/avatarCatalog');
const pricing = require('../pricing.service');

/**
 * The admin panel's Pricing & Levels section: the ladder, the earner share,
 * every woman's two levels with the totals behind them, upgrade history, and
 * what each level is earning. Reads only — the writes live in
 * `pricing.service`, where the app's own pricing reads them back.
 */

const DAY = 24 * 60 * 60 * 1000;

/** The ladder, the share, how many women sit at each level, and 30 days of money. */
async function overview({ days = 30 } = {}) {
  const since = new Date(Date.now() - days * DAY);

  const [voiceCounts, videoCounts, money] = await Promise.all([
    prisma.userProfile.groupBy({
      by: ['voiceLevel'],
      where: { gender: 'female', user: { deletedAt: null } },
      _count: { _all: true },
    }),
    prisma.userProfile.groupBy({
      by: ['videoLevel'],
      where: { gender: 'female', user: { deletedAt: null } },
      _count: { _all: true },
    }),
    // Per call type and the level the call was priced at. The payout is the
    // earnings actually credited, joined rather than recomputed, so it is the
    // figure the earners' wallets show.
    prisma.$queryRaw`
      SELECT c."type"::text AS type,
             c."earnerLevel" AS level,
             COUNT(*)::int AS calls,
             COALESCE(SUM(c."durationSeconds"), 0)::bigint AS seconds,
             COALESCE(SUM(c."amountSpent"), 0)::numeric AS revenue,
             COALESCE(SUM(e."amount"), 0)::numeric AS payout
        FROM "calls" c
        LEFT JOIN "earnings" e ON e."callId" = c."id"
       WHERE c."earnerLevel" IS NOT NULL
         AND c."status" = 'ended'
         AND c."amountSpent" > 0
         AND c."endedAt" >= ${since}
       GROUP BY 1, 2`,
  ]);

  const levels = {};
  for (const type of pricing.TYPES) {
    const counts = type === 'voice' ? voiceCounts : videoCounts;
    const key = type === 'voice' ? 'voiceLevel' : 'videoLevel';
    levels[type] = pricing.ladderFor(type).map((step) => {
      const row = money.find((m) => m.type === type && Number(m.level) === step.level);
      const revenue = Number(row?.revenue ?? 0);
      const payout = Number(row?.payout ?? 0);
      return {
        level: step.level,
        name: step.name,
        rate_per_minute: step.ratePerMinute,
        min_seconds: step.minSeconds,
        min_unique_callers: step.minUniqueCallers,
        women: counts.find((c) => c[key] === step.level)?._count._all ?? 0,
        calls: row?.calls ?? 0,
        seconds: Number(row?.seconds ?? 0),
        revenue,
        payout,
        platform: Math.round((revenue - payout) * 100) / 100,
      };
    });
  }

  return { ...pricing.settingsView(), levels, days };
}

/** Women with their two levels and the totals behind them. */
async function earners({ type = 'voice', level, search, sort = 'level', skip = 0, take = 25 }) {
  const levelKey = type === 'video' ? 'videoLevel' : 'voiceLevel';
  const where = {
    gender: 'female',
    user: { deletedAt: null },
    ...(level ? { [levelKey]: Number(level) } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { user: { phone: { contains: search } } },
            { userId: search },
          ],
        }
      : {}),
  };
  const orderBy =
    sort === 'recent'
      ? [{ updatedAt: 'desc' }]
      : [{ [levelKey]: 'desc' }, { totalCalls: 'desc' }];

  const [rows, total] = await Promise.all([
    prisma.userProfile.findMany({
      where,
      orderBy,
      skip,
      take,
      include: { user: { select: { id: true, phone: true, dialCode: true, callStats: true } } },
    }),
    prisma.userProfile.count({ where }),
  ]);

  return {
    total,
    items: rows.map((p) => ({
      id: p.userId,
      name: p.name,
      phone: p.user.phone ? `${p.user.dialCode ?? ''} ${p.user.phone}`.trim() : null,
      avatar_url: avatarCatalog.urlFor(p.avatarId),
      is_verified: p.isVerified,
      voice: levelSummary('voice', p.voiceLevel, p.user.callStats),
      video: levelSummary('video', p.videoLevel, p.user.callStats),
    })),
  };
}

function levelSummary(type, level, stats) {
  const row = stats.find((s) => s.type === type);
  const info = pricing.levelInfo(type, level);
  return {
    level: info.level,
    name: info.name,
    rate_per_minute: info.ratePerMinute,
    billable_seconds: row?.billableSeconds ?? 0,
    unique_callers: row?.uniqueCallers ?? 0,
    counted_calls: row?.countedCalls ?? 0,
  };
}

/** Level changes, newest first — everyone's, or one woman's. */
async function history({ userId, type, source, skip = 0, take = 25 }) {
  const where = {
    ...(userId ? { userId } : {}),
    ...(type ? { type } : {}),
    ...(source ? { source } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.earnerLevelChange.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      include: { user: { select: { profile: { select: { name: true, avatarId: true } } } } },
    }),
    prisma.earnerLevelChange.count({ where }),
  ]);
  return {
    total,
    items: rows.map((c) => ({
      ...pricing.serializeChange(c),
      user_name: c.user?.profile?.name ?? null,
      avatar_url: avatarCatalog.urlFor(c.user?.profile?.avatarId),
    })),
  };
}

/** One woman's levels and her most recent changes, for her user page. */
async function forUser(userId) {
  const [levels, recent] = await Promise.all([
    pricing.earnerLevels(userId),
    history({ userId, take: 20 }),
  ]);
  return { levels, history: recent.items };
}

module.exports = { overview, earners, history, forUser };
