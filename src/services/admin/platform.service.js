'use strict';

const prisma = require('../../config/prisma');
const { errors } = require('../../utils/errors');
const env = require('../../config/env');
const livekit = require('../livekit.service');
const activity = require('../activity.service');
const { emitToUser } = require('../../sockets/bus');
const {
  summarise,
  serializeCall,
  serializeActivity,
  PROFILE_INCLUDE,
} = require('./users.service');

/**
 * Everything the panel shows across all users rather than one.
 *
 * The per-user services answer "what has this person done"; this answers
 * "what is happening on the platform". They share serializers deliberately —
 * a call rendered on a user's page and the same call on the global page
 * should not be two different shapes with two different bugs.
 */

// ── Activity ────────────────────────────────────────────────────────────────

async function activityFeed({ userId, type, status, relatedUserId, from, to, search, skip = 0, take = 50 }) {
  const where = {};
  if (userId) where.userId = userId;
  if (relatedUserId) where.relatedUserId = relatedUserId;
  if (status) where.status = status;
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
      include: {
        user: { include: { profile: true } },
        relatedUser: { include: { profile: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.userActivity.count({ where }),
  ]);

  return {
    items: rows.map((a) => ({
      ...serializeActivity(a),
      user: {
        id: a.user.id,
        name: a.user.profile?.name ?? null,
        avatar_url: a.user.profile?.avatarUrl ?? null,
      },
    })),
    total,
  };
}

// ── Calls ───────────────────────────────────────────────────────────────────

async function callFeed({ type, status, userId, from, to, search, skip = 0, take = 25 }) {
  const where = {};
  if (type) where.type = type;
  if (status) {
    // "Active" is two statuses, not one — a phone that is ringing is as much
    // an in-progress call as a connected one for anybody watching this page.
    where.status = status === 'active' ? { in: ['ringing', 'connected'] } : status;
  }
  if (userId) where.OR = [{ callerId: userId }, { calleeId: userId }];
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }
  if (search) {
    where.AND = [
      {
        OR: [
          { id: search },
          { caller: { profile: { name: { contains: search, mode: 'insensitive' } } } },
          { callee: { profile: { name: { contains: search, mode: 'insensitive' } } } },
        ],
      },
    ];
  }

  const [rows, total, stats] = await Promise.all([
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
    prisma.call.aggregate({ where, _sum: { durationSeconds: true, amountSpent: true } }),
  ]);

  return {
    items: rows.map((c) => serializeCall(c, null)),
    total,
    totals: {
      duration_seconds: stats._sum.durationSeconds ?? 0,
      amount_spent: Number(stats._sum.amountSpent ?? 0),
    },
  };
}

/**
 * Calls in progress, cross-checked against LiveKit.
 *
 * The database says a call is connected; LiveKit says whether anybody is
 * actually in the room. The two disagreeing is the interesting case — a call
 * still billing with an empty room is money leaving a wallet for silence —
 * so both are shown rather than one being trusted.
 */
async function liveCalls() {
  const rows = await prisma.call.findMany({
    where: { status: { in: ['ringing', 'connected'] } },
    include: {
      caller: { include: PROFILE_INCLUDE },
      callee: { include: PROFILE_INCLUDE },
    },
    orderBy: { startedAt: 'desc' },
  });

  const calls = await Promise.all(
    rows.map(async (c) => {
      const base = serializeCall(c, null);
      if (!livekit.configured) return { ...base, media: null };

      const participants = await livekit.participants(c.id).catch(() => []);
      return {
        ...base,
        media: {
          room: livekit.roomName(c.id),
          participant_count: participants.length,
          participants: participants.map((p) => ({
            identity: p.identity,
            name: p.name || null,
            state: String(p.state),
            joined_at: p.joinedAt ? new Date(Number(p.joinedAt) * 1000).toISOString() : null,
            tracks: (p.tracks ?? []).map((t) => ({
              kind: t.type === 0 ? 'audio' : 'video',
              muted: t.muted,
            })),
          })),
          // Both sides present and publishing is what "connected" should mean.
          // Anything less on a connected call is worth an operator's attention.
          healthy: c.status !== 'connected' || participants.length >= 2,
        },
      };
    })
  );

  return {
    items: calls,
    livekit_configured: livekit.configured,
    livekit_url: livekit.configured ? env.livekit.url : null,
  };
}

/** Every LiveKit room, including any the database does not know about. */
async function livekitRooms() {
  if (!livekit.configured) {
    return { configured: false, reachable: false, url: null, items: [] };
  }

  // Configured and unreachable is its own state, and a common one — the URL
  // points at a media server that is down, or at a local container nobody
  // started. Letting the transport error escape turned the whole call monitor
  // into a 500, so the operator saw a broken page instead of "the media server
  // is not answering" next to a call list that was never LiveKit's to begin
  // with. The rows below it come from Postgres and are still true.
  let rooms;
  try {
    rooms = await livekit.listRooms();
  } catch (err) {
    return {
      configured: true,
      reachable: false,
      url: env.livekit.url,
      error: err?.message ?? 'The media server did not answer.',
      items: [],
    };
  }

  const callIds = rooms.map((r) => livekit.callIdFromRoom(r.name)).filter(Boolean);
  const calls = callIds.length
    ? await prisma.call.findMany({
        where: { id: { in: callIds } },
        include: {
          caller: { include: PROFILE_INCLUDE },
          callee: { include: PROFILE_INCLUDE },
        },
      })
    : [];
  const byId = new Map(calls.map((c) => [c.id, c]));

  return {
    configured: true,
    reachable: true,
    url: env.livekit.url,
    items: rooms.map((r) => {
      const callId = livekit.callIdFromRoom(r.name);
      const call = callId ? byId.get(callId) : null;
      return {
        name: r.name,
        sid: r.sid,
        participants: r.numParticipants,
        created_at: r.creationTime
          ? new Date(Number(r.creationTime) * 1000).toISOString()
          : null,
        call: call ? serializeCall(call, null) : null,
        // A room with no call behind it is an orphan the teardown missed.
        // Worth surfacing: it is the shape of a bug that costs money.
        orphaned: Boolean(callId && !call),
      };
    }),
  };
}

// ── Friend requests ─────────────────────────────────────────────────────────

async function friendRequestFeed({ status, userId, from, to, search, skip = 0, take = 25 }) {
  const where = {};
  if (status) where.status = status;
  if (userId) where.OR = [{ requesterId: userId }, { addresseeId: userId }];
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }
  if (search) {
    where.AND = [
      {
        OR: [
          { requester: { profile: { name: { contains: search, mode: 'insensitive' } } } },
          { addressee: { profile: { name: { contains: search, mode: 'insensitive' } } } },
        ],
      },
    ];
  }

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
      requester: summarise(r.requester),
      addressee: summarise(r.addressee),
      status: r.status,
      message: r.message,
      created_at: r.createdAt.toISOString(),
      responded_at: r.respondedAt?.toISOString() ?? null,
    })),
    total,
  };
}

// ── Verification ────────────────────────────────────────────────────────────

async function verificationFeed({ status, userId, from, to, skip = 0, take = 25 }) {
  const where = {};
  if (status) where.status = status;
  if (userId) where.userId = userId;
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }

  const [rows, total] = await Promise.all([
    prisma.verification.findMany({
      where,
      include: { user: { include: PROFILE_INCLUDE } },
      // Oldest first: this is a queue, and the person who has been waiting
      // longest should be at the top of it.
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
      skip,
      take,
    }),
    prisma.verification.count({ where }),
  ]);

  return {
    items: rows.map((v) => ({
      id: v.id,
      user: summarise(v.user),
      kind: v.kind,
      status: v.status,
      attempt: v.attempt,
      language_code: v.languageCode,
      duration_seconds: v.durationSeconds,
      rejection_reason: v.rejectionReason,
      review_notes: v.reviewNotes,
      reviewed_by: v.reviewedBy,
      reviewed_at: v.reviewedAt?.toISOString() ?? null,
      created_at: v.createdAt.toISOString(),
      has_recording: Boolean(v.sampleUrl),
    })),
    total,
  };
}

/**
 * Decides a verification.
 *
 * A rejection or a re-verification request **requires a reason**, because the
 * user is shown it and because an operator reviewing the decision later needs
 * to know what it was. Approving does not: "it was fine" is the default.
 *
 * The profile's `isVerified` flag moves with the decision — that flag is what
 * puts an account in the discovery feed, so leaving them to drift would mean
 * a rejected account still taking paid calls.
 */
async function decideVerification(verificationId, { decision, reason, notes, reviewer }) {
  const verification = await prisma.verification.findUnique({
    where: { id: verificationId },
    include: { user: { include: { profile: true } } },
  });
  if (!verification) throw errors.notFound('Verification', 'VERIFICATION_NOT_FOUND');

  const NEEDS_REASON = ['rejected', 'reverification_required'];
  if (NEEDS_REASON.includes(decision) && !reason?.trim()) {
    throw errors.badRequest(
      decision === 'rejected'
        ? 'A reason is required to reject a verification.'
        : 'A reason is required when asking for re-verification.'
    );
  }

  const updated = await prisma.verification.update({
    where: { id: verificationId },
    data: {
      status: decision,
      rejectionReason: NEEDS_REASON.includes(decision) ? reason.trim() : null,
      reviewNotes: notes?.trim() || null,
      reviewedBy: reviewer,
      reviewedAt: new Date(),
    },
  });

  // Approved means discoverable; anything else means not.
  if (decision === 'approved') {
    await prisma.userProfile.update({
      where: { userId: verification.userId },
      data: { isVerified: true },
    });
  } else if (decision === 'rejected' || decision === 'reverification_required') {
    await prisma.userProfile.update({
      where: { userId: verification.userId },
      data: { isVerified: false },
    });
  }

  const TYPES = {
    approved: 'verification_approved',
    rejected: 'verification_rejected',
    reverification_required: 'reverification_requested',
    under_review: 'verification_requested',
    expired: 'verification_rejected',
  };

  activity.record({
    userId: verification.userId,
    type: TYPES[decision] ?? 'verification_requested',
    relatedEntityId: verificationId,
    description:
      decision === 'approved'
        ? 'Voice verification approved by the administrator'
        : decision === 'reverification_required'
          ? `Re-verification requested — ${reason.trim()}`
          : `Voice verification ${decision}${reason ? ` — ${reason.trim()}` : ''}`,
    metadata: { decision, reason: reason?.trim() ?? null, by: reviewer },
    status: decision,
  });

  // Told, not left to discover it. A rejection the user never hears about is
  // an account that quietly stops working.
  await require('../notification.service')
    .notify({
      userId: verification.userId,
      kind: 'system',
      title:
        decision === 'approved'
          ? 'Voice verified'
          : decision === 'reverification_required'
            ? 'Please verify your voice again'
            : 'Voice verification was not accepted',
      body:
        decision === 'approved'
          ? 'You can take calls and earn on Vybli.'
          : (reason?.trim() ?? 'Record again in a quiet place.'),
      data: { verification_id: verificationId },
    })
    .catch(() => {});

  // `isVerified` decides whether the account is discoverable and whether it
  // may take paid calls, and the app caches it in session state. A
  // notification alone would tell the user they are verified while their own
  // Profile still said otherwise until the next cold start, so the socket
  // carries the fact as well as the announcement.
  emitToUser(verification.userId, 'profile:updated', {
    is_verified: decision === 'approved',
    reason: 'verification',
  });

  return { id: updated.id, status: updated.status, user_id: verification.userId };
}

/**
 * The stored recording for a verification.
 *
 * Returns the reference rather than a public link. The route streams it
 * through the authenticated endpoint and logs the access — a direct URL to
 * somebody's voice, guessable or not, is a public URL to somebody's voice.
 */
async function verificationRecording(verificationId) {
  const v = await prisma.verification.findUnique({
    where: { id: verificationId },
    select: {
      id: true,
      userId: true,
      kind: true,
      sampleUrl: true,
      durationSeconds: true,
      languageCode: true,
    },
  });
  if (!v) throw errors.notFound('Verification', 'VERIFICATION_NOT_FOUND');
  if (!v.sampleUrl) {
    throw errors.notFound('Recording', 'RECORDING_NOT_STORED');
  }
  return v;
}

// ── Moderation ──────────────────────────────────────────────────────────────

async function reportFeed({ status, userId, from, to, search, skip = 0, take = 25 }) {
  const where = {};
  if (status) where.status = status;
  if (userId) where.OR = [{ reporterId: userId }, { reportedId: userId }];
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }
  if (search) {
    where.AND = [
      {
        OR: [
          { reason: { contains: search, mode: 'insensitive' } },
          { details: { contains: search, mode: 'insensitive' } },
          { reported: { profile: { name: { contains: search, mode: 'insensitive' } } } },
        ],
      },
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.report.findMany({
      where,
      include: {
        reporter: { include: PROFILE_INCLUDE },
        reported: { include: PROFILE_INCLUDE },
      },
      // Open first, oldest first within that — a queue, same as verification.
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
      skip,
      take,
    }),
    prisma.report.count({ where }),
  ]);

  return {
    items: rows.map((r) => ({
      id: r.id,
      reporter: summarise(r.reporter),
      reported: summarise(r.reported),
      reason: r.reason,
      details: r.details,
      status: r.status,
      resolution: r.resolution,
      review_notes: r.reviewNotes,
      resolved_at: r.resolvedAt?.toISOString() ?? null,
      resolved_by: r.resolvedBy,
      created_at: r.createdAt.toISOString(),
    })),
    total,
  };
}

async function resolveReport(reportId, { status, resolution, notes, reviewer }) {
  const report = await prisma.report.findUnique({ where: { id: reportId } });
  if (!report) throw errors.notFound('Report', 'REPORT_NOT_FOUND');

  const CLOSING = ['resolved', 'dismissed'];
  if (CLOSING.includes(status) && !resolution?.trim()) {
    throw errors.badRequest('Say what was decided before closing a report.');
  }

  const updated = await prisma.report.update({
    where: { id: reportId },
    data: {
      status,
      resolution: resolution?.trim() || null,
      reviewNotes: notes?.trim() || null,
      resolvedAt: CLOSING.includes(status) ? new Date() : null,
      resolvedBy: CLOSING.includes(status) ? reviewer : null,
    },
  });

  return {
    id: updated.id,
    status: updated.status,
    resolution: updated.resolution,
    reported_id: report.reportedId,
  };
}

async function blockFeed({ userId, from, to, skip = 0, take = 25 }) {
  const where = {};
  if (userId) where.OR = [{ blockerId: userId }, { blockedId: userId }];
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }

  const [rows, total] = await Promise.all([
    prisma.block.findMany({
      where,
      include: {
        blocker: { include: PROFILE_INCLUDE },
        blocked: { include: PROFILE_INCLUDE },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.block.count({ where }),
  ]);

  return {
    items: rows.map((b) => ({
      id: b.id,
      blocker: summarise(b.blocker),
      blocked: summarise(b.blocked),
      created_at: b.createdAt.toISOString(),
      status: 'active',
    })),
    total,
  };
}

// ── Finance ─────────────────────────────────────────────────────────────────

async function walletFeed({ search, sort = 'balance', skip = 0, take = 25 }) {
  const where = search
    ? {
        user: {
          OR: [
            { phone: { contains: search } },
            { id: search },
            { profile: { name: { contains: search, mode: 'insensitive' } } },
          ],
        },
      }
    : {};

  const ORDER = {
    balance: { balance: 'desc' },
    earnings: { totalEarnings: 'desc' },
    available: { availableBalance: 'desc' },
    pending: { pendingBalance: 'desc' },
  };

  const [rows, total, totals] = await Promise.all([
    prisma.wallet.findMany({
      where,
      include: { user: { include: PROFILE_INCLUDE } },
      orderBy: ORDER[sort] ?? ORDER.balance,
      skip,
      take,
    }),
    prisma.wallet.count({ where }),
    prisma.wallet.aggregate({
      where,
      _sum: {
        balance: true,
        totalEarnings: true,
        availableBalance: true,
        pendingBalance: true,
      },
    }),
  ]);

  return {
    items: rows.map((w) => ({
      user: summarise(w.user),
      balance: Number(w.balance),
      total_earnings: Number(w.totalEarnings),
      available_balance: Number(w.availableBalance),
      pending_balance: Number(w.pendingBalance),
      updated_at: w.updatedAt.toISOString(),
    })),
    total,
    totals: {
      balance: Number(totals._sum.balance ?? 0),
      total_earnings: Number(totals._sum.totalEarnings ?? 0),
      available_balance: Number(totals._sum.availableBalance ?? 0),
      pending_balance: Number(totals._sum.pendingBalance ?? 0),
    },
  };
}

async function transactionFeed({ kind, status, userId, from, to, search, skip = 0, take = 25 }) {
  const where = {};
  if (kind) where.kind = kind;
  if (status) where.status = status;
  if (userId) where.wallet = { userId };
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }
  if (search) {
    where.OR = [
      { id: search },
      { title: { contains: search, mode: 'insensitive' } },
      { referenceId: search },
    ];
  }

  const [rows, total, totals] = await Promise.all([
    prisma.walletTransaction.findMany({
      where,
      include: { wallet: { include: { user: { include: PROFILE_INCLUDE } } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.walletTransaction.count({ where }),
    prisma.walletTransaction.aggregate({ where, _sum: { rupeeDelta: true } }),
  ]);

  return {
    items: rows.map((t) => ({
      id: t.id,
      user: t.wallet?.user ? summarise(t.wallet.user) : null,
      kind: t.kind,
      status: t.status,
      title: t.title,
      subtitle: t.subtitle,
      amount: Number(t.rupeeDelta ?? 0),
      reference_id: t.referenceId,
      created_at: t.createdAt.toISOString(),
    })),
    total,
    totals: {
      amount: Number(totals._sum.rupeeDelta ?? 0),
    },
  };
}

async function earningFeed({ status, userId, from, to, skip = 0, take = 25 }) {
  const where = {};
  if (status) where.status = status;
  if (userId) where.userId = userId;
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }

  const [rows, total, totals] = await Promise.all([
    prisma.earning.findMany({
      where,
      include: { user: { include: PROFILE_INCLUDE } },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.earning.count({ where }),
    prisma.earning.aggregate({ where, _sum: { amount: true, minutes: true } }),
  ]);

  return {
    items: rows.map((e) => ({
      id: e.id,
      user: summarise(e.user),
      call_id: e.callId,
      minutes: e.minutes,
      amount: Number(e.amount),
      rate_per_minute: Number(e.ratePerMinute),
      status: e.status,
      clears_at: e.clearsAt?.toISOString() ?? null,
      created_at: e.createdAt.toISOString(),
    })),
    total,
    totals: {
      amount: Number(totals._sum.amount ?? 0),
      minutes: totals._sum.minutes ?? 0,
    },
  };
}

/**
 * A manual wallet adjustment.
 *
 * The one write in this panel that creates money, so it is the one with the
 * most ceremony: a reason is mandatory, a ledger row is always written, and
 * the caller audits it. An adjustment with no ledger row would make the
 * balance and the transaction history disagree, and the history is what
 * anybody investigating actually reads.
 *
 * Two independent knobs: `balance` adjusts the spendable balance a call bills
 * against, `rupees` adjusts the withdrawable earnings balance directly. Both
 * land on the same ledger row when both are given.
 */
async function adjustWallet(userId, { balance = 0, rupees = 0, reason, reviewer }) {
  if (!reason?.trim()) throw errors.badRequest('A reason is required for a wallet adjustment.');
  if (!balance && !rupees) throw errors.badRequest('Enter an amount to adjust.');

  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet) throw errors.notFound('Wallet', 'WALLET_NOT_FOUND');

  if (balance < 0 && Number(wallet.balance) + balance < 0) {
    throw errors.badRequest('That would take the balance below zero.', {
      balance: Number(wallet.balance),
      requested: balance,
    });
  }

  const [updated, transaction] = await prisma.$transaction([
    prisma.wallet.update({
      where: { userId },
      data: {
        balance: { increment: balance },
        availableBalance: { increment: rupees },
      },
    }),
    prisma.walletTransaction.create({
      data: {
        walletId: wallet.id,
        // `bonus` rather than a new enum member: the ledger already means
        // "money that came from neither a purchase nor a call" by that name,
        // and the subtitle carries the operator's reason.
        kind: 'bonus',
        status: 'completed',
        title: 'Manual adjustment by administrator',
        subtitle: reason.trim(),
        rupeeDelta: balance + rupees,
      },
    }),
  ]);

  activity.record({
    userId,
    type: 'wallet_activity',
    relatedEntityId: transaction.id,
    description: `Administrator adjusted the wallet — ${reason.trim()}`,
    metadata: { balance, rupees, reason: reason.trim(), by: reviewer },
    status: 'completed',
  });

  // The balance on the user's phone is cached in session state and refreshed
  // on events, not polled. Without this the operator sees the adjustment land
  // and the user does not, until they next cold-start the app — which is the
  // worst possible gap for money.
  emitToUser(userId, 'wallet:updated', { balance: Number(updated.balance) });

  return {
    balance: Number(updated.balance),
    available_balance: Number(updated.availableBalance),
    transaction_id: transaction.id,
  };
}

// ── Catalogue ───────────────────────────────────────────────────────────────

async function languages({ search, includeInactive = true } = {}) {
  const where = {};
  if (!includeInactive) where.isActive = true;
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { nativeName: { contains: search, mode: 'insensitive' } },
      { code: { contains: search, mode: 'insensitive' } },
    ];
  }

  const rows = await prisma.language.findMany({
    where,
    include: { _count: { select: { users: true } } },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });

  return rows.map((l) => ({
    code: l.code,
    name: l.name,
    native_name: l.nativeName,
    is_popular: l.isPopular,
    is_active: l.isActive,
    sort_order: l.sortOrder,
    aliases: l.aliases,
    user_count: l._count.users,
  }));
}

async function upsertLanguage({ code, name, nativeName, isPopular, isActive, sortOrder }) {
  if (!code?.trim() || !name?.trim()) {
    throw errors.badRequest('A language needs a code and a name.');
  }
  const data = {
    name: name.trim(),
    nativeName: (nativeName || name).trim(),
    isPopular: Boolean(isPopular),
    isActive: isActive !== false,
    sortOrder: Number(sortOrder) || 0,
  };
  return prisma.language.upsert({
    where: { code: code.trim() },
    create: { code: code.trim(), ...data },
    update: data,
  });
}

async function cities({ search, includeInactive = true } = {}) {
  const where = {};
  if (!includeInactive) where.isActive = true;
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { state: { contains: search, mode: 'insensitive' } },
      { region: { contains: search, mode: 'insensitive' } },
      { id: { contains: search, mode: 'insensitive' } },
    ];
  }

  const rows = await prisma.city.findMany({
    where,
    include: { _count: { select: { profiles: true } } },
    orderBy: [{ isPopular: 'desc' }, { name: 'asc' }],
  });

  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    state: c.state,
    country: c.country,
    region: c.region,
    is_popular: c.isPopular,
    is_active: c.isActive,
    user_count: c._count.profiles,
  }));
}

async function upsertCity({ id, name, state, country, region, isPopular, isActive }) {
  if (!id?.trim() || !name?.trim() || !state?.trim()) {
    throw errors.badRequest('A city needs an id, a name and a state.');
  }
  const data = {
    name: name.trim(),
    state: state.trim(),
    country: (country || 'India').trim(),
    region: region?.trim() || null,
    isPopular: Boolean(isPopular),
    isActive: isActive !== false,
  };
  return prisma.city.upsert({
    where: { id: id.trim() },
    create: { id: id.trim(), ...data },
    update: data,
  });
}

// ── Notifications ───────────────────────────────────────────────────────────

async function notificationFeed({ kind, userId, unreadOnly, from, to, skip = 0, take = 25 }) {
  const where = {};
  if (kind) where.kind = kind;
  if (userId) where.userId = userId;
  if (unreadOnly) where.readAt = null;
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }

  const [rows, total] = await Promise.all([
    prisma.notification.findMany({
      where,
      include: { user: { include: PROFILE_INCLUDE } },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.notification.count({ where }),
  ]);

  return {
    items: rows.map((n) => ({
      id: n.id,
      user: summarise(n.user),
      kind: n.kind,
      title: n.title,
      body: n.body,
      data: n.data,
      is_read: Boolean(n.readAt),
      read_at: n.readAt?.toISOString() ?? null,
      created_at: n.createdAt.toISOString(),
    })),
    total,
  };
}

// ── Audit ───────────────────────────────────────────────────────────────────

/** Read-only, always. There is no update or delete path anywhere. */
async function auditLog({ action, userId, targetType, from, to, search, skip = 0, take = 50 }) {
  const where = {};
  if (action) where.action = action;
  if (userId) where.userId = userId;
  if (targetType) where.targetType = targetType;
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }
  if (search) where.description = { contains: search, mode: 'insensitive' };

  const [rows, total, actions] = await Promise.all([
    prisma.adminAuditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
    prisma.adminAuditLog.count({ where }),
    // The distinct actions present, so the filter offers what exists rather
    // than a hard-coded list that rots.
    prisma.adminAuditLog.findMany({
      distinct: ['action'],
      select: { action: true },
      orderBy: { action: 'asc' },
    }),
  ]);

  // Names for the users referenced, resolved in one query rather than per row.
  const userIds = [...new Set(rows.map((r) => r.userId).filter(Boolean))];
  const users = userIds.length
    ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        include: { profile: true },
      })
    : [];
  const byId = new Map(users.map((u) => [u.id, u]));

  return {
    items: rows.map((r) => ({
      id: r.id,
      action: r.action,
      target_type: r.targetType,
      target_id: r.targetId,
      user: r.userId
        ? {
            id: r.userId,
            name: byId.get(r.userId)?.profile?.name ?? null,
          }
        : null,
      description: r.description,
      metadata: r.metadata,
      ip: r.ip,
      user_agent: r.userAgent,
      created_at: r.createdAt.toISOString(),
    })),
    total,
    actions: actions.map((a) => a.action),
  };
}

module.exports = {
  activityFeed,
  callFeed,
  liveCalls,
  livekitRooms,
  friendRequestFeed,
  verificationFeed,
  decideVerification,
  verificationRecording,
  reportFeed,
  resolveReport,
  blockFeed,
  walletFeed,
  transactionFeed,
  earningFeed,
  adjustWallet,
  languages,
  upsertLanguage,
  cities,
  upsertCity,
  notificationFeed,
  auditLog,
};
