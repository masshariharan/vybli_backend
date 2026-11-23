'use strict';

const prisma = require('../config/prisma');
const avatarCatalog = require('../config/avatarCatalog');
const { errors } = require('../utils/errors');
const { emitToUser } = require('../sockets/bus');

/**
 * Disconnected calls — the live calls somebody else ended on a woman.
 *
 * A call counts when it was **connected** and the **other person** ended it:
 * he hung up, or his connection dropped. It does not count when she ended it
 * herself, when it ran out of balance (nobody chose that), or when the server
 * closed it during a sweep and so cannot say whose side went.
 *
 * **Women only**, on both ends of it. A row is written only when the person
 * left on the call is a woman, and the two reads refuse anyone else — the
 * screen exists so an earner can see who keeps cutting her calls short.
 *
 * **Its own table** (`CallDisconnect`), not a query over `Call`: clearing call
 * history hard-deletes those rows, and this must outlive either side tidying
 * a call log. `callId` is unique, so a duplicated end event writes nothing
 * the second time.
 *
 * **Never in the way of a call.** [record] runs in the background
 * bookkeeping after `call:ended` has already gone out, and its caller logs
 * a failure rather than raising it.
 */

/** The only endings that are somebody disconnecting. */
const REASONS = new Set(['hungUp', 'networkError']);

/** A call ended sooner than this is a "quick" disconnect. */
const QUICK_SECONDS = 60;

/** This many disconnects in the period marks someone as frequent. */
const FREQUENT_AT = 3;

/** How many people the overview lists — the ones worth knowing about. */
const TOP_USERS = 20;

const RANGE_DAYS = { '7d': 7, '30d': 30, all: null };

function assertWoman(user) {
  if (user?.profile?.gender !== 'female') {
    throw errors.forbidden('This is only available to women.', 'WOMEN_ONLY');
  }
}

function whereFor(userId, range) {
  const days = RANGE_DAYS[range] ?? null;
  const where = { userId };
  if (days) where.createdAt = { gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) };
  return where;
}

/**
 * Notes a finished call as a disconnect, if it was one. Idempotent.
 *
 * [call] is the finished row with both people loaded; [endedById] is whoever
 * ended it, or null when nobody in particular did.
 *
 * Returns the row's owner id when a row was written, otherwise null.
 */
async function record({ call, endedById, reason }) {
  if (!call || call.status !== 'ended' || !call.connectedAt) return null;
  if (!REASONS.has(reason)) return null;
  if (!endedById) return null;
  if (endedById !== call.callerId && endedById !== call.calleeId) return null;

  const left = endedById === call.callerId ? call.callee : call.caller;
  const leftId = endedById === call.callerId ? call.calleeId : call.callerId;
  if (left?.profile?.gender !== 'female') return null;

  const { count } = await prisma.callDisconnect.createMany({
    data: [
      {
        callId: call.id,
        userId: leftId,
        byUserId: endedById,
        type: call.type,
        reason,
        durationSeconds: Math.max(0, Number(call.durationSeconds) || 0),
        createdAt: call.endedAt ?? new Date(),
      },
    ],
    skipDuplicates: true,
  });
  if (count === 0) return null;

  // Her screen refetches on this, so the figures move as the call ends.
  emitToUser(leftId, 'disconnects:updated', { call_id: call.id });
  return leftId;
}

/** Names and avatars for [userIds], keyed by id. */
async function peopleById(userIds) {
  if (userIds.length === 0) return new Map();
  const profiles = await prisma.userProfile.findMany({
    where: { userId: { in: userIds } },
    select: { userId: true, name: true, avatarId: true },
  });
  return new Map(profiles.map((p) => [p.userId, p]));
}

function person(people, userId) {
  const profile = people.get(userId);
  return {
    user_id: userId,
    // Someone who has since closed their account still disconnected.
    user_name: profile?.name ?? 'Unknown',
    avatar_url: avatarCatalog.urlFor(profile?.avatarId),
  };
}

/**
 * The summary cards and the people behind them, for one period.
 *
 * People are ordered by how often they disconnected, most first, then by who
 * did it most recently.
 */
async function overview(user, { range = '30d' } = {}) {
  assertWoman(user);
  const where = whereFor(user.id, range);

  const [totals, quick, groups] = await Promise.all([
    prisma.callDisconnect.aggregate({
      where,
      _count: { _all: true },
      _avg: { durationSeconds: true },
    }),
    prisma.callDisconnect.count({
      where: { ...where, durationSeconds: { lt: QUICK_SECONDS } },
    }),
    prisma.callDisconnect.groupBy({
      by: ['byUserId'],
      where,
      _count: { _all: true },
      _avg: { durationSeconds: true },
      _max: { createdAt: true },
    }),
  ]);

  const ranked = groups
    .map((g) => ({
      userId: g.byUserId,
      count: g._count._all,
      avgSeconds: Math.round(g._avg.durationSeconds ?? 0),
      lastAt: g._max.createdAt,
    }))
    .sort((a, b) => b.count - a.count || new Date(b.lastAt) - new Date(a.lastAt));

  const top = ranked.slice(0, TOP_USERS);
  const people = await peopleById(top.map((r) => r.userId));

  return {
    range,
    summary: {
      total_disconnected: totals._count._all,
      unique_users: ranked.length,
      frequent_users: ranked.filter((r) => r.count >= FREQUENT_AT).length,
      quick_disconnects: quick,
      avg_duration_seconds: Math.round(totals._avg.durationSeconds ?? 0),
    },
    quick_seconds: QUICK_SECONDS,
    frequent_at: FREQUENT_AT,
    users: top.map((r) => ({
      ...person(people, r.userId),
      count: r.count,
      avg_duration_seconds: r.avgSeconds,
      last_at: new Date(r.lastAt).toISOString(),
      frequent: r.count >= FREQUENT_AT,
    })),
  };
}

/** Every disconnected call, newest first — optionally one person's. */
async function history(user, { range = '30d', userId, skip, take } = {}) {
  assertWoman(user);
  const where = whereFor(user.id, range);
  if (userId) where.byUserId = userId;

  const [rows, total] = await Promise.all([
    prisma.callDisconnect.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip,
      take,
    }),
    prisma.callDisconnect.count({ where }),
  ]);

  const people = await peopleById([...new Set(rows.map((r) => r.byUserId))]);
  return {
    total,
    items: rows.map((r) => ({
      id: r.id,
      ...person(people, r.byUserId),
      type: r.type,
      reason: r.reason,
      duration_seconds: r.durationSeconds,
      quick: r.durationSeconds < QUICK_SECONDS,
      ended_at: new Date(r.createdAt).toISOString(),
    })),
  };
}

module.exports = { record, overview, history, QUICK_SECONDS, FREQUENT_AT };
