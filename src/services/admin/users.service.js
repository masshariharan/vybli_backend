'use strict';

const prisma = require('../../config/prisma');
const { errors } = require('../../utils/errors');
const avatarCatalog = require('../../config/avatarCatalog');
const activity = require('../activity.service');
const { emitToUser } = require('../../sockets/bus');

/**
 * Everything the admin panel knows about a person.
 *
 * The shape here is the whole point of the product: an operator answering
 * "what has this account been doing" should not have to open six screens and
 * hold the answer in their head. So one user id gets a full picture — profile,
 * graph, conversations, calls, money, verification, moderation — each behind
 * its own paginated call so no single request drags a hundred thousand
 * messages out of the database.
 *
 * Two rules run through all of it:
 *
 *  * **Live accounts only, unless asked.** A deleted user keeps its row so
 *    call history and ledger foreign keys survive. Every list filters them out
 *    by default, or every count on the dashboard would be wrong.
 *  * **Pagination is not optional.** Every list here takes skip/take and
 *    returns a total. The one endpoint that forgets is the one that falls over
 *    on the busiest account.
 */

const PROFILE_INCLUDE = {
  profile: true,
  languages: true,
};

/** Trimmed to what a table row renders, so a page of 50 is not a page of 50 profiles. */
function summarise(user) {
  const p = user.profile;
  return {
    id: user.id,
    phone: `${user.dialCode} ${user.phone}`,
    name: p?.name || null,
    avatar_url: avatarCatalog.urlFor(p?.avatarId),
    gender: p?.gender ?? null,
    age: p?.age ?? null,
    // The id. The catalogue that turned it into a name lived in this database
    // and does not any more — it belongs to the mobile client, which is the
    // only place a city is rendered to somebody who lives in one.
    city_id: p?.cityId ?? null,
    // Codes. The catalogue that turned these into names lived in this
    // database and does not any more — it belongs to the mobile client, which
    // is the only place a language is rendered to somebody who speaks it.
    languages: (user.languages ?? []).map((l) => l.languageCode),
    goal: p?.goal ?? null,
    is_earner: p?.isEarner ?? false,
    is_verified: p?.isVerified ?? false,
    presence: p?.presence ?? 'offline',
    last_seen: p?.lastSeen?.toISOString() ?? null,
    onboarding_status: p?.onboardingStatus ?? null,
    account_status: user.status,
    suspended_at: user.suspendedAt?.toISOString() ?? null,
    suspended_reason: user.suspendedReason ?? null,
    deleted_at: user.deletedAt?.toISOString() ?? null,
    created_at: user.createdAt.toISOString(),
    verification_status: p?.verificationStatus ?? null,
    // Counted in the same query rather than N+1'd per row.
    counts: user._count
      ? {
          friends: (user._count.friendshipsA ?? 0) + (user._count.friendshipsB ?? 0),
          calls: (user._count.callsMade ?? 0) + (user._count.callsReceived ?? 0),
          messages: user._count.messages ?? 0,
          reports_against: user._count.reportsAgainst ?? 0,
        }
      : undefined,
    wallet: user.wallet
      ? {
          balance: Number(user.wallet.balance),
          available_balance: Number(user.wallet.availableBalance),
          total_earnings: Number(user.wallet.totalEarnings),
          payout_upi_id: user.wallet.payoutUpiId ?? null,
        }
      : null,
  };
}

/** The `_count` block every list shares. */
const LIST_COUNTS = {
  _count: {
    select: {
      friendshipsA: true,
      friendshipsB: true,
      callsMade: true,
      callsReceived: true,
      messages: true,
      reportsAgainst: true,
    },
  },
};

const ACTIVE_WINDOW_MS = 24 * 3600_000;

// The independent toolbar facets, whitelisted so a stray query-string value
// is silently ignored rather than reaching Prisma as an invalid enum and
// turning into a 500.
const TYPE_VALUES = new Set(['earner', 'call_user']);
const PRESENCE_VALUES = new Set(['online', 'offline', 'busy']);
const VERIFICATION_VALUES = new Set(['pending', 'verified', 'rejected']);
const STATUS_VALUES = new Set(['active', 'suspended', 'deleted']);

/**
 * Turns the UI's filter chips into a `where`.
 *
 * One function so the Users page, the "Online Users" shortcut and the
 * "Pending Verification" shortcut cannot disagree about what those words mean.
 *
 * `type` / `presence` / `verification` / `status` are the redesigned
 * toolbar's four independent dropdowns — combinable with each other and with
 * `filter`, which stays only for the sidebar's existing shortcut links.
 */
function buildWhere({ search, filter, from, to, includeDeleted, type, presence, verification, status }) {
  const where = {};
  if (!includeDeleted) where.deletedAt = null;

  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }

  if (search) {
    const term = search.trim();
    // Phone, name and id. The id is matched exactly — a partial cuid is not a
    // search anyone performs deliberately, and `contains` on it would make
    // every query a sequential scan.
    where.OR = [
      { phone: { contains: term } },
      { id: term },
      { profile: { name: { contains: term, mode: 'insensitive' } } },
      { profile: { bio: { contains: term, mode: 'insensitive' } } },
    ];
  }

  switch (filter) {
    case 'online':
      where.profile = { ...(where.profile ?? {}), presence: 'online' };
      break;
    case 'offline':
      where.profile = { ...(where.profile ?? {}), presence: 'offline' };
      break;
    case 'busy':
      where.profile = { ...(where.profile ?? {}), presence: 'busy' };
      break;
    case 'active':
      where.profile = {
        ...(where.profile ?? {}),
        lastSeen: { gte: new Date(Date.now() - ACTIVE_WINDOW_MS) },
      };
      break;
    case 'verified':
      where.profile = { ...(where.profile ?? {}), isVerified: true };
      break;
    case 'unverified':
      where.profile = { ...(where.profile ?? {}), isVerified: false };
      break;
    case 'earners':
      where.profile = { ...(where.profile ?? {}), isEarner: true };
      break;
    case 'pending_verification':
      where.profile = { ...(where.profile ?? {}), verificationStatus: 'pending' };
      break;
    case 'suspended':
      where.status = 'suspended';
      break;
    case 'deleted':
      delete where.deletedAt;
      where.deletedAt = { not: null };
      break;
    case 'reported':
      where.reportsAgainst = { some: {} };
      break;
    case 'blocked':
      // People this platform's users have blocked, which is not the same as a
      // suspended account — worth its own filter because it is the signal that
      // usually precedes a report.
      where.blocksReceived = { some: {} };
      break;
    default:
      break;
  }

  if (TYPE_VALUES.has(type)) {
    where.profile = { ...(where.profile ?? {}), isEarner: type === 'earner' };
  }

  if (PRESENCE_VALUES.has(presence)) {
    where.profile = { ...(where.profile ?? {}), presence };
  }

  if (verification === 'none') {
    where.profile = { ...(where.profile ?? {}), verificationStatus: 'not_required' };
  } else if (VERIFICATION_VALUES.has(verification)) {
    where.profile = { ...(where.profile ?? {}), verificationStatus: verification };
  }

  if (STATUS_VALUES.has(status)) {
    if (status === 'deleted') {
      delete where.deletedAt;
      where.deletedAt = { not: null };
    } else {
      where.status = status;
    }
  }

  return where;
}

const SORTS = {
  created_at: (dir) => ({ createdAt: dir }),
  last_seen: (dir) => ({ profile: { lastSeen: dir } }),
  name: (dir) => ({ profile: { name: dir } }),
  status: (dir) => ({ status: dir }),
};

async function list({
  search,
  filter = 'all',
  type,
  presence,
  verification,
  status,
  sort = 'created_at',
  direction = 'desc',
  from,
  to,
  skip = 0,
  take = 25,
  includeDeleted = false,
}) {
  const where = buildWhere({ search, filter, from, to, includeDeleted, type, presence, verification, status });
  const dir = direction === 'asc' ? 'asc' : 'desc';
  const orderBy = (SORTS[sort] ?? SORTS.created_at)(dir);

  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      include: {
        ...PROFILE_INCLUDE,
        wallet: true,
        ...LIST_COUNTS,
      },
      orderBy,
      skip,
      take,
    }),
    prisma.user.count({ where }),
  ]);

  return { items: rows.map(summarise), total };
}

/** The Overview tab: the profile, plus every statistic on one screen. */
async function overview(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      ...PROFILE_INCLUDE,
      wallet: true,
    },
  });
  if (!user) throw errors.notFound('User', 'USER_NOT_FOUND');

  const [
    friendsA,
    friendsB,
    sentRequests,
    receivedRequests,
    acceptedRequests,
    rejectedRequests,
    receivedAccepted,
    receivedRejected,
    receivedPending,
    conversations,
    messages,
    voiceCalls,
    videoCalls,
    completedCalls,
    missedCalls,
    callSeconds,
    voiceSeconds,
    videoSeconds,
    earnings,
    amountSpent,
    reportsAgainst,
    reportsMade,
    blocksMade,
    blocksReceived,
    notifications,
    unreadNotifications,
    sessions,
    lastSession,
    nextSettlement,
    lastPayout,
    lastActivity,
  ] = await Promise.all([
    prisma.friendship.count({ where: { userAId: userId } }),
    prisma.friendship.count({ where: { userBId: userId } }),
    prisma.friendRequest.count({ where: { requesterId: userId } }),
    prisma.friendRequest.count({ where: { addresseeId: userId } }),
    prisma.friendRequest.count({
      where: { OR: [{ requesterId: userId }, { addresseeId: userId }], status: 'accepted' },
    }),
    prisma.friendRequest.count({
      where: { OR: [{ requesterId: userId }, { addresseeId: userId }], status: 'rejected' },
    }),
    // Split by direction too — the "requests this person received and how
    // they answered" ratio on the Overview screen reads oddly if it is
    // secretly counting requests *they* sent as well.
    prisma.friendRequest.count({ where: { addresseeId: userId, status: 'accepted' } }),
    prisma.friendRequest.count({ where: { addresseeId: userId, status: 'rejected' } }),
    prisma.friendRequest.count({ where: { addresseeId: userId, status: 'pending' } }),
    prisma.conversation.count({ where: { OR: [{ userAId: userId }, { userBId: userId }] } }),
    prisma.message.count({ where: { senderId: userId } }),
    prisma.call.count({
      where: { type: 'voice', OR: [{ callerId: userId }, { calleeId: userId }] },
    }),
    prisma.call.count({
      where: { type: 'video', OR: [{ callerId: userId }, { calleeId: userId }] },
    }),
    prisma.call.count({
      where: { status: 'ended', OR: [{ callerId: userId }, { calleeId: userId }] },
    }),
    prisma.call.count({
      where: { status: 'missed', OR: [{ callerId: userId }, { calleeId: userId }] },
    }),
    prisma.call.aggregate({
      _sum: { durationSeconds: true },
      where: { OR: [{ callerId: userId }, { calleeId: userId }] },
    }),
    prisma.call.aggregate({
      _sum: { durationSeconds: true },
      where: { type: 'voice', OR: [{ callerId: userId }, { calleeId: userId }] },
    }),
    prisma.call.aggregate({
      _sum: { durationSeconds: true },
      where: { type: 'video', OR: [{ callerId: userId }, { calleeId: userId }] },
    }),
    prisma.earning.aggregate({ _sum: { amount: true }, where: { userId } }),
    // Call-user accounts never earn — what they have instead is what they've
    // spent, which is this same ledger read from the other side.
    prisma.walletTransaction.aggregate({
      _sum: { rupeeDelta: true },
      where: { wallet: { userId }, kind: 'call' },
    }),
    prisma.report.count({ where: { reportedId: userId } }),
    prisma.report.count({ where: { reporterId: userId } }),
    prisma.block.count({ where: { blockerId: userId } }),
    prisma.block.count({ where: { blockedId: userId } }),
    prisma.notification.count({ where: { userId } }),
    prisma.notification.count({ where: { userId, readAt: null } }),
    prisma.userSession.count({ where: { userId, revokedAt: null } }),
    // For "Last Known IP" / device — the most recent sign-in, active or not.
    prisma.userSession.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { ip: true, device: true, revokedAt: true, expiresAt: true },
    }),
    // The earliest still-clearing earning is what actually settles next —
    // never a made-up payout schedule.
    prisma.earning.findFirst({
      where: { userId, status: 'pending' },
      orderBy: { clearsAt: 'asc' },
      select: { clearsAt: true, amount: true },
    }),
    prisma.walletTransaction.findFirst({
      where: { wallet: { userId }, kind: 'withdrawal', status: 'completed' },
      orderBy: { createdAt: 'desc' },
      select: { rupeeDelta: true, createdAt: true },
    }),
    prisma.userActivity.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, type: true, description: true },
    }),
  ]);

  return {
    user: summarise(user),
    profile: {
      bio: user.profile?.bio ?? null,
      voice_rate_per_minute: user.profile?.voiceRatePerMinute != null
        ? Number(user.profile.voiceRatePerMinute)
        : null,
      video_rate_per_minute: user.profile?.videoRatePerMinute != null
        ? Number(user.profile.videoRatePerMinute)
        : null,
      rating: user.profile?.rating ?? null,
      total_calls: user.profile?.totalCalls ?? 0,
      voice_enabled: user.profile?.voiceEnabled ?? null,
      video_enabled: user.profile?.videoEnabled ?? null,
    },
    // Manual and off the profile directly — there is no per-attempt row any
    // more. `not_required` (a call-user, or an earner who hasn't finished
    // onboarding yet) renders as no badge at all.
    verification: user.profile && user.profile.verificationStatus !== 'not_required'
      ? {
          status: user.profile.verificationStatus,
          requested_at: user.profile.verificationRequestedAt?.toISOString() ?? null,
          verified_at: user.profile.verifiedAt?.toISOString() ?? null,
          verified_by: user.profile.verifiedBy ?? null,
          rejection_reason: user.profile.rejectionReason ?? null,
        }
      : null,
    last_session: lastSession
      ? {
          ip: lastSession.ip ?? null,
          device: lastSession.device ?? null,
          active: !lastSession.revokedAt && lastSession.expiresAt > new Date(),
        }
      : null,
    stats: {
      friends: friendsA + friendsB,
      requests_sent: sentRequests,
      requests_received: receivedRequests,
      requests_accepted: acceptedRequests,
      requests_rejected: rejectedRequests,
      requests_received_accepted: receivedAccepted,
      requests_received_rejected: receivedRejected,
      requests_received_pending: receivedPending,
      conversations,
      messages_sent: messages,
      voice_calls: voiceCalls,
      video_calls: videoCalls,
      completed_calls: completedCalls,
      missed_calls: missedCalls,
      total_call_seconds: callSeconds._sum.durationSeconds ?? 0,
      voice_call_seconds: voiceSeconds._sum.durationSeconds ?? 0,
      video_call_seconds: videoSeconds._sum.durationSeconds ?? 0,
      total_earnings: Number(earnings._sum.amount ?? 0),
      amount_spent: Math.abs(Number(amountSpent._sum.rupeeDelta ?? 0)),
      wallet_balance: Number(user.wallet?.balance ?? 0),
      wallet_available: Number(user.wallet?.availableBalance ?? 0),
      wallet_pending: Number(user.wallet?.pendingBalance ?? 0),
      next_settlement_at: nextSettlement?.clearsAt?.toISOString() ?? null,
      next_settlement_amount: nextSettlement ? Number(nextSettlement.amount) : null,
      last_payout_amount: lastPayout ? Math.abs(Number(lastPayout.rupeeDelta ?? 0)) : null,
      last_payout_at: lastPayout?.createdAt?.toISOString() ?? null,
      reports_against: reportsAgainst,
      reports_made: reportsMade,
      blocks_made: blocksMade,
      blocked_by: blocksReceived,
      notifications,
      unread_notifications: unreadNotifications,
      active_sessions: sessions,
    },
    last_activity: lastActivity
      ? {
          at: lastActivity.createdAt.toISOString(),
          type: lastActivity.type,
          description: lastActivity.description,
        }
      : null,
  };
}

// ── Tabs ────────────────────────────────────────────────────────────────────

const peer = (row, userId) => (row.userAId === userId ? row.userB : row.userA);

async function friends(userId, { skip = 0, take = 25 } = {}) {
  const where = { OR: [{ userAId: userId }, { userBId: userId }] };
  const [rows, total] = await Promise.all([
    prisma.friendship.findMany({
      where,
      include: {
        userA: { include: PROFILE_INCLUDE },
        userB: { include: PROFILE_INCLUDE },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.friendship.count({ where }),
  ]);

  // The last thing that happened between the two, which is what tells an
  // operator whether a friendship is live or historical.
  const items = await Promise.all(
    rows.map(async (row) => {
      const other = peer(row, userId);
      const [lastMessage, lastCall] = await Promise.all([
        prisma.message.findFirst({
          where: {
            conversation: {
              OR: [
                { userAId: userId, userBId: other.id },
                { userAId: other.id, userBId: userId },
              ],
            },
          },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        }),
        prisma.call.findFirst({
          where: {
            OR: [
              { callerId: userId, calleeId: other.id },
              { callerId: other.id, calleeId: userId },
            ],
          },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        }),
      ]);

      const interactions = [lastMessage?.createdAt, lastCall?.createdAt].filter(Boolean);
      return {
        friendship_id: row.id,
        friend: summarise(other),
        since: row.createdAt.toISOString(),
        last_interaction: interactions.length
          ? new Date(Math.max(...interactions.map((d) => d.getTime()))).toISOString()
          : null,
      };
    })
  );

  return { items, total };
}

async function requests(userId, { direction = 'all', status, skip = 0, take = 25 } = {}) {
  const where = {};
  if (direction === 'sent') where.requesterId = userId;
  else if (direction === 'received') where.addresseeId = userId;
  else where.OR = [{ requesterId: userId }, { addresseeId: userId }];
  if (status) where.status = status;

  const [rows, total] = await Promise.all([
    prisma.friendRequest.findMany({
      where,
      include: {
        requester: { include: PROFILE_INCLUDE },
        addressee: { include: PROFILE_INCLUDE },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.friendRequest.count({ where }),
  ]);

  return {
    items: rows.map((r) => ({
      id: r.id,
      direction: r.requesterId === userId ? 'sent' : 'received',
      counterpart: summarise(r.requesterId === userId ? r.addressee : r.requester),
      status: r.status,
      message: r.message,
      created_at: r.createdAt.toISOString(),
      responded_at: r.respondedAt?.toISOString() ?? null,
    })),
    total,
  };
}

async function calls(userId, { type, status, from, to, search, skip = 0, take = 25 } = {}) {
  const where = { OR: [{ callerId: userId }, { calleeId: userId }] };
  if (type) where.type = type;
  if (status) where.status = status;
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }
  if (search) {
    // Search the *other* participant by name, which is what an operator
    // means by "calls with Meera".
    where.AND = [
      {
        OR: [
          { caller: { profile: { name: { contains: search, mode: 'insensitive' } } } },
          { callee: { profile: { name: { contains: search, mode: 'insensitive' } } } },
        ],
      },
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.call.findMany({
      where,
      include: {
        caller: { include: PROFILE_INCLUDE },
        callee: { include: PROFILE_INCLUDE },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.call.count({ where }),
  ]);

  return { items: rows.map((c) => serializeCall(c, userId)), total };
}

function serializeCall(c, viewerId) {
  const outgoing = viewerId ? c.callerId === viewerId : true;
  const other = outgoing ? c.callee : c.caller;
  return {
    id: c.id,
    caller: summarise(c.caller),
    callee: summarise(c.callee),
    counterpart: viewerId ? summarise(other) : null,
    direction: viewerId ? (outgoing ? 'outgoing' : 'incoming') : null,
    type: c.type,
    status: c.status,
    is_random: c.isRandom,
    started_at: c.startedAt.toISOString(),
    connected_at: c.connectedAt?.toISOString() ?? null,
    ended_at: c.endedAt?.toISOString() ?? null,
    duration_seconds: c.durationSeconds,
    amount_spent: Number(c.amountSpent),
    rate_per_minute: Number(c.ratePerMinute),
    end_reason: c.endReason,
    rating: c.rating,
    // The room this call used, so an operator can line a call up against a
    // LiveKit session without knowing the naming convention.
    livekit_room: `call_${c.id}`,
  };
}

async function timeline(userId, { type, from, to, search, skip = 0, take = 50 } = {}) {
  const where = { userId };
  if (type) where.type = Array.isArray(type) ? { in: type } : type;
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }
  if (search) where.description = { contains: search, mode: 'insensitive' };

  const [rows, total] = await Promise.all([
    prisma.userActivity.findMany({
      where,
      include: { relatedUser: { include: { profile: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.userActivity.count({ where }),
  ]);

  return { items: rows.map(serializeActivity), total };
}

function serializeActivity(a) {
  return {
    id: a.id,
    user_id: a.userId,
    type: a.type,
    description: a.description,
    related_user: a.relatedUser
      ? {
          id: a.relatedUser.id,
          name: a.relatedUser.profile?.name ?? null,
          avatar_url: avatarCatalog.urlFor(a.relatedUser.profile?.avatarId),
        }
      : null,
    related_entity_id: a.relatedEntityId,
    metadata: a.metadata ?? null,
    status: a.status,
    created_at: a.createdAt.toISOString(),
  };
}

async function wallet(userId) {
  const [w, earned, spent, pending, completed, lastTx] = await Promise.all([
    prisma.wallet.findUnique({ where: { userId } }),
    prisma.earning.aggregate({ _sum: { amount: true }, where: { userId } }),
    prisma.walletTransaction.aggregate({
      _sum: { rupeeDelta: true },
      where: { wallet: { userId }, kind: 'call' },
    }),
    prisma.earning.aggregate({ _sum: { amount: true }, where: { userId, status: 'pending' } }),
    prisma.earning.aggregate({
      _sum: { amount: true },
      where: { userId, status: { in: ['available', 'withdrawn'] } },
    }),
    prisma.walletTransaction.findFirst({
      where: { wallet: { userId } },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  if (!w) return null;
  return {
    balance: Number(w.balance),
    available_balance: Number(w.availableBalance),
    pending_balance: Number(w.pendingBalance),
    total_earnings: Number(w.totalEarnings),
    total_earned: Number(earned._sum.amount ?? 0),
    // Spend is stored as a negative delta; shown as a positive figure.
    total_spent: Math.abs(Number(spent._sum.rupeeDelta ?? 0)),
    pending_earnings: Number(pending._sum.amount ?? 0),
    completed_earnings: Number(completed._sum.amount ?? 0),
    last_transaction: lastTx
      ? {
          id: lastTx.id,
          kind: lastTx.kind,
          status: lastTx.status,
          title: lastTx.title,
          amount: Number(lastTx.rupeeDelta ?? 0),
          created_at: lastTx.createdAt.toISOString(),
        }
      : null,
  };
}

async function transactions(userId, { kind, status, from, to, search, skip = 0, take = 25 } = {}) {
  const where = { wallet: { userId } };
  if (kind) where.kind = kind;
  if (status) where.status = status;
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }
  if (search) {
    where.OR = [
      { title: { contains: search, mode: 'insensitive' } },
      { subtitle: { contains: search, mode: 'insensitive' } },
      { id: search },
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.walletTransaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.walletTransaction.count({ where }),
  ]);

  return {
    items: rows.map((t) => ({
      id: t.id,
      kind: t.kind,
      status: t.status,
      title: t.title,
      subtitle: t.subtitle,
      amount: Number(t.rupeeDelta ?? 0),
      reference_id: t.referenceId,
      created_at: t.createdAt.toISOString(),
    })),
    total,
  };
}

async function earnings(userId, { status, skip = 0, take = 25 } = {}) {
  const where = { userId };
  if (status) where.status = status;

  const [rows, total] = await Promise.all([
    prisma.earning.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.earning.count({ where }),
  ]);

  // The call each earning came from, and who was on the other end.
  const callIds = rows.map((r) => r.callId).filter(Boolean);
  const callRows = callIds.length
    ? await prisma.call.findMany({
        where: { id: { in: callIds } },
        include: { caller: { include: PROFILE_INCLUDE }, callee: { include: PROFILE_INCLUDE } },
      })
    : [];
  const callsById = new Map(callRows.map((c) => [c.id, c]));

  return {
    items: rows.map((e) => {
      const call = callsById.get(e.callId);
      const other = call ? (call.calleeId === userId ? call.caller : call.callee) : null;
      return {
        id: e.id,
        call_id: e.callId,
        counterpart: other ? summarise(other) : null,
        duration_seconds: call?.durationSeconds ?? null,
        minutes: e.minutes,
        amount: Number(e.amount),
        rate_per_minute: Number(e.ratePerMinute),
        status: e.status,
        clears_at: e.clearsAt?.toISOString() ?? null,
        created_at: e.createdAt.toISOString(),
      };
    }),
    total,
  };
}

async function reports(userId, { skip = 0, take = 25 } = {}) {
  const [against, made] = await Promise.all([
    prisma.report.findMany({
      where: { reportedId: userId },
      include: { reporter: { include: PROFILE_INCLUDE } },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.report.findMany({
      where: { reporterId: userId },
      include: { reported: { include: PROFILE_INCLUDE } },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
  ]);

  const shape = (r, counterpart) => ({
    id: r.id,
    counterpart: summarise(counterpart),
    reason: r.reason,
    details: r.details,
    status: r.status,
    resolution: r.resolution,
    review_notes: r.reviewNotes,
    resolved_at: r.resolvedAt?.toISOString() ?? null,
    resolved_by: r.resolvedBy,
    created_at: r.createdAt.toISOString(),
  });

  return {
    against: against.map((r) => shape(r, r.reporter)),
    made: made.map((r) => shape(r, r.reported)),
  };
}

async function blocks(userId) {
  const [made, received] = await Promise.all([
    prisma.block.findMany({
      where: { blockerId: userId },
      include: { blocked: { include: PROFILE_INCLUDE } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.block.findMany({
      where: { blockedId: userId },
      include: { blocker: { include: PROFILE_INCLUDE } },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  return {
    // Blocks are hard-deleted on unblock, so a row here is a live block and
    // there is no unblock date to show. The unblock itself is on the timeline.
    made: made.map((b) => ({
      id: b.id,
      user: summarise(b.blocked),
      blocked_at: b.createdAt.toISOString(),
      status: 'active',
    })),
    received: received.map((b) => ({
      id: b.id,
      user: summarise(b.blocker),
      blocked_at: b.createdAt.toISOString(),
      status: 'active',
    })),
  };
}

async function notifications(userId, { kind, unreadOnly, skip = 0, take = 25 } = {}) {
  const where = { userId };
  if (kind) where.kind = kind;
  if (unreadOnly) where.readAt = null;

  const [rows, total] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
    prisma.notification.count({ where }),
  ]);

  return {
    items: rows.map((n) => ({
      id: n.id,
      kind: n.kind,
      title: n.title,
      body: n.body,
      data: n.data,
      read_at: n.readAt?.toISOString() ?? null,
      is_read: Boolean(n.readAt),
      created_at: n.createdAt.toISOString(),
    })),
    total,
  };
}

/**
 * The Account History tab.
 *
 * Sessions and account-level activity merged into one list. Sign-ins live in
 * `user_sessions` because that is what the refresh flow needs, and everything
 * else is on the timeline — an operator asking "what happened to this account"
 * should not have to know that.
 */
async function accountHistory(userId, { skip = 0, take = 50 } = {}) {
  const ACCOUNT_TYPES = [
    'registration',
    'login',
    'logout',
    'otp_verified',
    'profile_updated',
    'language_updated',
    'location_updated',
    'onboarding_step',
    'verification_requested',
    'verification_approved',
    'verification_rejected',
    'reverification_requested',
    'account_status_changed',
    'account_deleted',
  ];

  const where = { userId, type: { in: ACCOUNT_TYPES } };
  const [rows, total, sessions, adminActions] = await Promise.all([
    prisma.userActivity.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
    prisma.userActivity.count({ where }),
    prisma.userSession.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 25,
    }),
    // What the administrator has done to this account, shown alongside — the
    // history is incomplete without it, and it is the part an operator is
    // most often trying to reconstruct.
    prisma.adminAuditLog.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 25,
    }),
  ]);

  return {
    items: rows.map(serializeActivity),
    total,
    sessions: sessions.map((s) => ({
      id: s.id,
      device: s.device,
      ip: s.ip,
      created_at: s.createdAt.toISOString(),
      expires_at: s.expiresAt.toISOString(),
      revoked_at: s.revokedAt?.toISOString() ?? null,
      active: !s.revokedAt && s.expiresAt > new Date(),
    })),
    admin_actions: adminActions.map((a) => ({
      id: a.id,
      action: a.action,
      description: a.description,
      created_at: a.createdAt.toISOString(),
    })),
  };
}

// ── Account actions ─────────────────────────────────────────────────────────

/**
 * Suspends or restores an account.
 *
 * A reason is required for suspension. A status with no reason is one nobody
 * can review later or explain to the person it happened to — and this is the
 * action most likely to be questioned.
 *
 * Suspending revokes every session, or the account keeps working until its
 * access token expires.
 */
async function setStatus(userId, { status, reason }) {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { profile: true } });
  if (!user) throw errors.notFound('User', 'USER_NOT_FOUND');
  if (user.deletedAt) {
    throw errors.conflict('That account has been deleted.', 'USER_DELETED');
  }
  if (status === 'suspended' && !reason?.trim()) {
    throw errors.badRequest('A reason is required to suspend an account.');
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      status,
      suspendedAt: status === 'suspended' ? new Date() : null,
      suspendedReason: status === 'suspended' ? reason.trim() : null,
    },
    include: { ...PROFILE_INCLUDE, wallet: true },
  });

  if (status === 'suspended') {
    await prisma.userSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    // Off the discovery feed immediately, rather than at their next heartbeat.
    await prisma.userProfile.updateMany({
      where: { userId },
      data: { presence: 'offline' },
    });

    // Revoking the refresh tokens above does not reach a phone that is already
    // running: its access token stays valid for its remaining lifetime and its
    // socket stays open, so a suspended account could keep calling and
    // messaging for up to fifteen minutes. Telling the client is what closes
    // that window.
    emitToUser(userId, 'session:revoked', {
      reason: reason.trim(),
      at: new Date().toISOString(),
    });
  }

  activity.record({
    userId,
    type: 'account_status_changed',
    description:
      status === 'suspended'
        ? `Account suspended by the administrator — ${reason.trim()}`
        : 'Account restored by the administrator',
    metadata: { status, reason: reason?.trim() ?? null, by: 'admin' },
    status,
  });

  return summarise(updated);
}

/**
 * Ends every session for an account, without changing the account.
 *
 * The control an operator reaches for when they want somebody *out* — a lost
 * phone, a shared login, a session that should not still be open — but has no
 * cause to suspend them.
 *
 * It also fills a gap that surprises people: **deleting a user in the Firebase
 * console does not sign them out here.** Firebase proves the phone number once,
 * at sign-in, and is never consulted again — every request after that is
 * authenticated by this server's own JWT against its own `user_sessions` table.
 * Removing the Firebase user stops the *next* sign-in from recognising them and
 * changes nothing about a session already issued, which can live for 30 days.
 * This is that button.
 *
 * Both halves are needed. Revoking the refresh tokens closes the long-lived
 * credential, but a phone that is already running keeps a valid access token
 * for up to its 15-minute lifetime and keeps its socket open — so the client is
 * told as well, and signs itself out on the spot.
 */
async function signOutEverywhere(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, deletedAt: true },
  });
  if (!user || user.deletedAt) throw errors.notFound('User', 'USER_NOT_FOUND');

  const { count } = await prisma.userSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  emitToUser(userId, 'session:revoked', {
    reason: 'An administrator signed you out.',
    at: new Date().toISOString(),
  });

  activity.record({
    userId,
    type: 'logout',
    description: `Signed out of every device by the administrator (${count} session${count === 1 ? '' : 's'})`,
    metadata: { sessions_revoked: count, by: 'admin' },
    status: 'completed',
  });

  return { sessions_revoked: count };
}

module.exports = {
  list,
  overview,
  signOutEverywhere,
  friends,
  requests,
  calls,
  timeline,
  wallet,
  transactions,
  earnings,
  reports,
  blocks,
  notifications,
  accountHistory,
  setStatus,
  summarise,
  serializeCall,
  serializeActivity,
  PROFILE_INCLUDE,
};
