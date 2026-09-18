'use strict';

const prisma = require('../../config/prisma');
const env = require('../../config/env');

/**
 * The numbers on the dashboard.
 *
 * Every one is a `count` or an `aggregate` against Postgres. Nothing here is
 * derived from a cached total, and nothing is a constant — a dashboard that
 * shows a plausible number rather than the true one is worse than a dashboard
 * showing nothing, because the operator acts on it.
 *
 * The counts run concurrently. There are ~40 of them and they are all index
 * scans, so the round trips dominate; issuing them in sequence would turn a
 * 60ms page into a 2-second one.
 */

/** Midnight today, in the server's timezone. */
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysAgo(n) {
  const d = startOfToday();
  d.setDate(d.getDate() - n);
  return d;
}

/**
 * "Active" means seen in the last 24 hours.
 *
 * A definition rather than a fact, so it is stated here once instead of being
 * re-invented differently on each screen.
 */
function activeSince() {
  return new Date(Date.now() - 24 * 3600_000);
}

async function overview() {
  const today = startOfToday();
  const week = daysAgo(7);
  const month = daysAgo(30);

  // `deletedAt: null` on every user count. A deleted account keeps its row so
  // call history and ledger foreign keys survive, so counting rows without
  // this would inflate every user figure on the page by however many people
  // have ever left.
  const live = { deletedAt: null };

  const [
    totalUsers,
    newToday,
    newWeek,
    newMonth,
    activeUsers,
    onlineUsers,
    busyUsers,
    verifiedUsers,
    pendingVerification,
    suspendedUsers,
    earnerUsers,

    activeCalls,
    voiceCalls,
    videoCalls,
    completedCalls,
    missedCalls,
    failedCalls,
    callDuration,
    totalConversations,
    activeConversations,
    totalMessages,
    messagesToday,

    verifPending,
    verifVerified,
    verifRejected,

    walletTotals,
    balanceTotals,
    txPending,
    txCompleted,
    txFailed,

    reportsOpen,
    reportsReviewing,
    reportsResolved,
    reportsDismissed,
    totalBlocks,
  ] = await Promise.all([
    prisma.user.count({ where: live }),
    prisma.user.count({ where: { ...live, createdAt: { gte: today } } }),
    prisma.user.count({ where: { ...live, createdAt: { gte: week } } }),
    prisma.user.count({ where: { ...live, createdAt: { gte: month } } }),
    prisma.userProfile.count({ where: { lastSeen: { gte: activeSince() } } }),
    prisma.userProfile.count({ where: { presence: 'online' } }),
    prisma.userProfile.count({ where: { presence: 'busy' } }),
    prisma.userProfile.count({ where: { isVerified: true } }),
    prisma.userProfile.count({ where: { verificationStatus: 'pending' } }),
    prisma.user.count({ where: { status: 'suspended', deletedAt: null } }),
    prisma.userProfile.count({ where: { isEarner: true } }),

    prisma.call.count({ where: { status: { in: ['ringing', 'connected'] } } }),
    prisma.call.count({ where: { type: 'voice' } }),
    prisma.call.count({ where: { type: 'video' } }),
    prisma.call.count({ where: { status: 'ended' } }),
    prisma.call.count({ where: { status: 'missed' } }),
    prisma.call.count({ where: { status: 'failed' } }),
    prisma.call.aggregate({ _sum: { durationSeconds: true } }),
    prisma.conversation.count(),
    prisma.conversation.count({ where: { lastMessageAt: { gte: week } } }),
    prisma.message.count(),
    prisma.message.count({ where: { createdAt: { gte: today } } }),

    prisma.userProfile.count({ where: { verificationStatus: 'pending' } }),
    prisma.userProfile.count({ where: { verificationStatus: 'verified' } }),
    prisma.userProfile.count({ where: { verificationStatus: 'rejected' } }),

    prisma.wallet.aggregate({
      _sum: { totalEarnings: true, availableBalance: true, pendingBalance: true },
    }),
    prisma.wallet.aggregate({ _sum: { balance: true } }),
    prisma.walletTransaction.count({ where: { status: 'pending' } }),
    prisma.walletTransaction.count({ where: { status: 'completed' } }),
    prisma.walletTransaction.count({ where: { status: 'failed' } }),

    prisma.report.count({ where: { status: 'open' } }),
    prisma.report.count({ where: { status: 'reviewing' } }),
    prisma.report.count({ where: { status: 'resolved' } }),
    prisma.report.count({ where: { status: 'dismissed' } }),
    prisma.block.count(),
  ]);

  return {
    users: {
      total: totalUsers,
      new_today: newToday,
      new_this_week: newWeek,
      new_this_month: newMonth,
      active: activeUsers,
      online: onlineUsers,
      busy: busyUsers,
      // Everyone who is not online or busy. Derived rather than counted, so
      // the three always add up to the total on screen.
      offline: Math.max(0, totalUsers - onlineUsers - busyUsers),
      verified: verifiedUsers,
      unverified: Math.max(0, totalUsers - verifiedUsers),
      pending_verification: pendingVerification,
      suspended: suspendedUsers,
      earners: earnerUsers,
    },
    communication: {
      active_calls: activeCalls,
      voice_calls: voiceCalls,
      video_calls: videoCalls,
      completed_calls: completedCalls,
      missed_calls: missedCalls,
      failed_calls: failedCalls,
      total_call_seconds: callDuration._sum.durationSeconds ?? 0,
      conversations: totalConversations,
      active_conversations: activeConversations,
      messages: totalMessages,
      messages_today: messagesToday,
    },
    verification: {
      pending: verifPending,
      verified: verifVerified,
      rejected: verifRejected,
    },
    finance: {
      total_balance: money(balanceTotals._sum.balance),
      total_earnings: money(walletTotals._sum.totalEarnings),
      available_balance: money(walletTotals._sum.availableBalance),
      pending_balance: money(walletTotals._sum.pendingBalance),
      transactions_pending: txPending,
      transactions_completed: txCompleted,
      transactions_failed: txFailed,
    },
    moderation: {
      reports_open: reportsOpen,
      reports_reviewing: reportsReviewing,
      reports_resolved: reportsResolved,
      reports_dismissed: reportsDismissed,
      blocks: totalBlocks,
    },
    meta: {
      generated_at: new Date().toISOString(),
      livekit_configured: env.livekit.configured,
    },
  };
}

function money(value) {
  return value == null ? 0 : Number(Number(value).toFixed(2));
}

// ── Analytics ───────────────────────────────────────────────────────────────

/**
 * A day-by-day series for one metric.
 *
 * Grouped in SQL rather than pulled into Node and bucketed there: a month of
 * messages can be hundreds of thousands of rows, and the answer is fourteen
 * numbers.
 *
 * Days with no rows are filled in as zero. A chart that silently skips empty
 * days draws a line straight through an outage and makes it look like traffic.
 */
async function series({ metric, from, to }) {
  const spec = SERIES[metric];
  if (!spec) return null;

  const rows = await spec.query(from, to);
  return fillDays(rows, from, to);
}

/**
 * One `date_trunc` group-by per metric.
 *
 * Raw SQL because Prisma's `groupBy` cannot truncate a timestamp to a day, and
 * the alternative — a `findMany` of every row in the window — is exactly the
 * "load everything and count it in JavaScript" this avoids.
 */
const SERIES = {
  registrations: (from, to) =>
    prisma.$queryRaw`
      SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::int AS value
      FROM users WHERE "createdAt" >= ${from} AND "createdAt" < ${to} AND "deletedAt" IS NULL
      GROUP BY 1 ORDER BY 1`,

  active_users: (from, to) =>
    prisma.$queryRaw`
      SELECT date_trunc('day', "createdAt") AS day, COUNT(DISTINCT "userId")::int AS value
      FROM user_activities WHERE "createdAt" >= ${from} AND "createdAt" < ${to}
      GROUP BY 1 ORDER BY 1`,

  logins: (from, to) =>
    prisma.$queryRaw`
      SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::int AS value
      FROM user_activities WHERE type = 'login' AND "createdAt" >= ${from} AND "createdAt" < ${to}
      GROUP BY 1 ORDER BY 1`,

  voice_calls: (from, to) =>
    prisma.$queryRaw`
      SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::int AS value
      FROM calls WHERE type = 'voice' AND "createdAt" >= ${from} AND "createdAt" < ${to}
      GROUP BY 1 ORDER BY 1`,

  video_calls: (from, to) =>
    prisma.$queryRaw`
      SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::int AS value
      FROM calls WHERE type = 'video' AND "createdAt" >= ${from} AND "createdAt" < ${to}
      GROUP BY 1 ORDER BY 1`,

  call_minutes: (from, to) =>
    prisma.$queryRaw`
      SELECT date_trunc('day', "createdAt") AS day,
             COALESCE(ROUND(SUM("durationSeconds") / 60.0), 0)::int AS value
      FROM calls WHERE "createdAt" >= ${from} AND "createdAt" < ${to}
      GROUP BY 1 ORDER BY 1`,

  messages: (from, to) =>
    prisma.$queryRaw`
      SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::int AS value
      FROM messages WHERE "createdAt" >= ${from} AND "createdAt" < ${to}
      GROUP BY 1 ORDER BY 1`,

  verifications: (from, to) =>
    prisma.$queryRaw`
      SELECT date_trunc('day', "verificationRequestedAt") AS day, COUNT(*)::int AS value
      FROM user_profiles
      WHERE "verificationRequestedAt" >= ${from} AND "verificationRequestedAt" < ${to}
      GROUP BY 1 ORDER BY 1`,

  verifications_approved: (from, to) =>
    prisma.$queryRaw`
      SELECT date_trunc('day', "verifiedAt") AS day, COUNT(*)::int AS value
      FROM user_profiles
      WHERE "verificationStatus" = 'verified' AND "verifiedAt" >= ${from} AND "verifiedAt" < ${to}
      GROUP BY 1 ORDER BY 1`,

  verifications_rejected: (from, to) =>
    prisma.$queryRaw`
      SELECT date_trunc('day', "verifiedAt") AS day, COUNT(*)::int AS value
      FROM user_profiles
      WHERE "verificationStatus" = 'rejected' AND "verifiedAt" >= ${from} AND "verifiedAt" < ${to}
      GROUP BY 1 ORDER BY 1`,

  earnings: (from, to) =>
    prisma.$queryRaw`
      SELECT date_trunc('day', "createdAt") AS day, COALESCE(SUM(amount), 0)::float AS value
      FROM earnings WHERE "createdAt" >= ${from} AND "createdAt" < ${to}
      GROUP BY 1 ORDER BY 1`,

  transactions: (from, to) =>
    prisma.$queryRaw`
      SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::int AS value
      FROM wallet_transactions WHERE "createdAt" >= ${from} AND "createdAt" < ${to}
      GROUP BY 1 ORDER BY 1`,

  reports: (from, to) =>
    prisma.$queryRaw`
      SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::int AS value
      FROM reports WHERE "createdAt" >= ${from} AND "createdAt" < ${to}
      GROUP BY 1 ORDER BY 1`,
};

// Each entry is `(from, to) => Promise<rows>`; wrap so `series` can call
// `spec.query` uniformly whether or not a metric ever grows options.
for (const key of Object.keys(SERIES)) {
  const fn = SERIES[key];
  SERIES[key] = { query: fn };
}

/** Zero-fills the gaps so a quiet day reads as zero, not as a missing point. */
function fillDays(rows, from, to) {
  const byDay = new Map(
    rows.map((r) => [new Date(r.day).toISOString().slice(0, 10), Number(r.value)])
  );

  const out = [];
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);
  const end = new Date(to);

  while (cursor < end) {
    const key = cursor.toISOString().slice(0, 10);
    out.push({ date: key, value: byDay.get(key) ?? 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

const METRICS = Object.keys(SERIES);

module.exports = { overview, series, METRICS, startOfToday, daysAgo };
