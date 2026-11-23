'use strict';

const prisma = require('../../config/prisma');
const avatarCatalog = require('../../config/avatarCatalog');
const { QUICK_SECONDS, FREQUENT_AT } = require('../disconnect.service');

/**
 * Disconnected calls, for the admin panel — the only place they are shown.
 *
 * Three reads over `CallDisconnect` (written by `disconnect.service` as each
 * call ends): the summary figures, the people who disconnect ranked by how
 * often, and every disconnected call. "Who disconnected" is always the person
 * who ended the call; "earner" is the woman it was ended on.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** `days` of 0 (or anything not a positive number) means all time. */
function since(days) {
  const n = Number(days);
  return Number.isFinite(n) && n > 0 ? new Date(Date.now() - n * DAY_MS) : null;
}

function periodWhere(days) {
  const from = since(days);
  return from ? { createdAt: { gte: from } } : {};
}

/** People by id, in the shape the panel's `Person` cell takes. */
async function peopleById(userIds) {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      dialCode: true,
      phone: true,
      deletedAt: true,
      profile: { select: { name: true, avatarId: true, gender: true } },
    },
  });
  return new Map(users.map((u) => [u.id, u]));
}

function person(people, userId) {
  const u = people.get(userId);
  return {
    id: userId,
    // Someone who has since closed their account still disconnected.
    name: u?.profile?.name ?? null,
    // A deleted account's number is scrubbed for reuse — not worth showing.
    phone: u && !u.deletedAt && u.phone ? `${u.dialCode} ${u.phone}` : null,
    gender: u?.profile?.gender ?? null,
    avatar_url: avatarCatalog.urlFor(u?.profile?.avatarId),
    deleted: Boolean(u?.deletedAt) || !u,
  };
}

/** Ids of accounts whose name or number matches [search]. */
async function matchingUserIds(search) {
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { phone: { contains: search } },
        { profile: { name: { contains: search, mode: 'insensitive' } } },
      ],
    },
    select: { id: true },
    take: 500,
  });
  return users.map((u) => u.id);
}

/** Every disconnecting person in the period, most frequent first. */
async function ranked(where) {
  const groups = await prisma.callDisconnect.groupBy({
    by: ['byUserId'],
    where,
    _count: { _all: true },
    _avg: { durationSeconds: true },
    _max: { createdAt: true },
  });
  return groups
    .map((g) => ({
      userId: g.byUserId,
      count: g._count._all,
      avgSeconds: Math.round(g._avg.durationSeconds ?? 0),
      lastAt: g._max.createdAt,
    }))
    .sort((a, b) => b.count - a.count || new Date(b.lastAt) - new Date(a.lastAt));
}

/** The summary cards. */
async function overview({ days = 30 } = {}) {
  const where = periodWhere(days);

  const [totals, quick, dropped, people, earners] = await Promise.all([
    prisma.callDisconnect.aggregate({
      where,
      _count: { _all: true },
      _avg: { durationSeconds: true },
    }),
    prisma.callDisconnect.count({
      where: { ...where, durationSeconds: { lt: QUICK_SECONDS } },
    }),
    prisma.callDisconnect.count({ where: { ...where, reason: 'networkError' } }),
    ranked(where),
    prisma.callDisconnect.groupBy({ by: ['userId'], where, _count: { _all: true } }),
  ]);

  const total = totals._count._all;
  return {
    days: since(days) ? Number(days) : 0,
    quick_seconds: QUICK_SECONDS,
    frequent_at: FREQUENT_AT,
    summary: {
      total_disconnected: total,
      // Distinct people who ended a call on someone.
      unique_users: people.length,
      frequent_users: people.filter((p) => p.count >= FREQUENT_AT).length,
      // Distinct women it happened to.
      earners_affected: earners.length,
      avg_duration_seconds: Math.round(totals._avg.durationSeconds ?? 0),
      quick_disconnects: quick,
      hung_up: total - dropped,
      connection_lost: dropped,
    },
  };
}

/**
 * Who disconnects, and how often — one row per person, most frequent first.
 *
 * `frequent: true` narrows it to the repeat offenders.
 */
async function users({ days = 30, search, frequent = false, skip = 0, take = 25 } = {}) {
  const where = periodWhere(days);
  if (search) where.byUserId = { in: await matchingUserIds(search) };

  let rows = await ranked(where);
  if (frequent) rows = rows.filter((r) => r.count >= FREQUENT_AT);
  const total = rows.length;
  const pageRows = rows.slice(skip, skip + take);
  const ids = pageRows.map((r) => r.userId);

  // Two more facts about the people on this page only: how many different
  // women each cut off, and how many of their disconnects were quick.
  const [pairs, quick, people] = await Promise.all([
    ids.length
      ? prisma.callDisconnect.groupBy({
          by: ['byUserId', 'userId'],
          where: { ...where, byUserId: { in: ids } },
          _count: { _all: true },
        })
      : [],
    ids.length
      ? prisma.callDisconnect.groupBy({
          by: ['byUserId'],
          where: { ...where, byUserId: { in: ids }, durationSeconds: { lt: QUICK_SECONDS } },
          _count: { _all: true },
        })
      : [],
    peopleById(ids),
  ]);
  const earnersOf = new Map();
  for (const p of pairs) earnersOf.set(p.byUserId, (earnersOf.get(p.byUserId) ?? 0) + 1);
  const quickOf = new Map(quick.map((q) => [q.byUserId, q._count._all]));

  return {
    total,
    items: pageRows.map((r) => ({
      user: person(people, r.userId),
      count: r.count,
      earners_affected: earnersOf.get(r.userId) ?? 0,
      quick_disconnects: quickOf.get(r.userId) ?? 0,
      avg_duration_seconds: r.avgSeconds,
      last_at: new Date(r.lastAt).toISOString(),
      frequent: r.count >= FREQUENT_AT,
    })),
  };
}

/** Every disconnected call, newest first. */
async function history({
  days = 30,
  byUserId,
  earnerId,
  type,
  reason,
  search,
  skip = 0,
  take = 25,
} = {}) {
  const where = periodWhere(days);
  if (byUserId) where.byUserId = byUserId;
  if (earnerId) where.userId = earnerId;
  if (type) where.type = type;
  if (reason) where.reason = reason;
  if (search) {
    const ids = await matchingUserIds(search);
    where.OR = [{ byUserId: { in: ids } }, { userId: { in: ids } }];
  }

  const [rows, total] = await Promise.all([
    prisma.callDisconnect.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip,
      take,
    }),
    prisma.callDisconnect.count({ where }),
  ]);
  const people = await peopleById(rows.flatMap((r) => [r.byUserId, r.userId]));

  return {
    total,
    items: rows.map((r) => ({
      id: r.id,
      call_id: r.callId,
      by: person(people, r.byUserId),
      earner: person(people, r.userId),
      type: r.type,
      reason: r.reason,
      duration_seconds: r.durationSeconds,
      quick: r.durationSeconds < QUICK_SECONDS,
      ended_at: new Date(r.createdAt).toISOString(),
    })),
  };
}

module.exports = { overview, users, history };
