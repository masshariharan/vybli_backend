'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');

const { requireAdmin } = require('../middleware/adminAuth');
const { asyncHandler } = require('../middleware/error');
const { ok } = require('../utils/respond');
const env = require('../config/env');

const adminAuth = require('../services/admin/auth.service');
const audit = require('../services/admin/audit.service');
const dashboard = require('../services/admin/dashboard.service');
const users = require('../services/admin/users.service');
const messages = require('../services/admin/messages.service');
const platform = require('../services/admin/platform.service');

/**
 * The admin API.
 *
 * Mounted at `/api/v1/admin`. Everything past the login route sits behind
 * [requireAdmin], applied to the router rather than to each handler — the
 * failure mode of per-route guards is one endpoint that quietly returns
 * somebody's private messages, indistinguishable from the guarded ones until
 * someone finds it.
 *
 * The frontend never reaches Postgres or LiveKit. It talks to this, this talks
 * to the services, and the credentials stay in the process.
 */

const router = express.Router();
const h = asyncHandler;

/** Query helpers. Pagination is applied to every list, without exception. */
function page(req, defaultTake = 25) {
  const take = Math.min(Math.max(Number(req.query.limit) || defaultTake, 1), 200);
  const pageNo = Math.max(Number(req.query.page) || 1, 1);
  return { skip: (pageNo - 1) * take, take, page: pageNo, limit: take };
}

function range(req) {
  return { from: req.query.from || undefined, to: req.query.to || undefined };
}

function str(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s.length ? s : undefined;
}

/** `{ items, total }` plus the pagination envelope the frontend reads. */
function listed(res, result, { page: pageNo, limit }, message = 'OK') {
  return ok(
    res,
    {
      items: result.items,
      ...(result.totals ? { totals: result.totals } : {}),
      ...(result.actions ? { actions: result.actions } : {}),
      pagination: {
        page: pageNo,
        limit,
        total: result.total,
        pages: Math.max(1, Math.ceil(result.total / limit)),
      },
    },
    message
  );
}

// ── Authentication ──────────────────────────────────────────────────────────

/**
 * Deliberately tighter than the global limiter.
 *
 * The per-address lockout in the auth service counts *wrong passwords*; this
 * counts requests, which is what stops a distributed guess from costing a
 * bcrypt comparison each time.
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => env.isTest,
  message: {
    success: false,
    message: 'Too many sign-in attempts. Wait a few minutes.',
    error: 'RATE_LIMITED',
  },
});

router.post(
  '/auth/login',
  loginLimiter,
  h(async (req, res) => {
    const { username, password } = req.body ?? {};
    try {
      const session = await adminAuth.login({ username, password, ip: req.ip });
      audit.login(req, { username: session.username });
      return ok(res, session, 'Signed in');
    } catch (err) {
      // Logged whether or not it succeeded. A run of failures against the
      // panel is exactly the thing worth being able to see afterwards.
      audit.loginFailed(req, { username, reason: err.code ?? 'ERROR' });
      throw err;
    }
  })
);

// Everything below requires a valid admin session.
router.use(requireAdmin);

router.post(
  '/auth/logout',
  h(async (req, res) => {
    // Stateless tokens, so this is the client discarding it plus an audit row.
    // A server-side revocation list for a single-admin panel with 8-hour
    // tokens would be state to maintain for no practical gain.
    audit.logout(req);
    return ok(res, { signed_out: true }, 'Signed out');
  })
);

router.get('/auth/session', (req, res) =>
  ok(
    res,
    {
      username: env.admin.username,
      session_id: req.admin.sid,
      expires_at: new Date(req.admin.exp * 1000).toISOString(),
    },
    'Signed in'
  )
);

// ── Dashboard ───────────────────────────────────────────────────────────────

router.get('/dashboard', h(async (_req, res) => ok(res, await dashboard.overview(), 'Dashboard')));

router.get(
  '/dashboard/analytics',
  h(async (req, res) => {
    const metrics = String(req.query.metrics || 'registrations')
      .split(',')
      .map((m) => m.trim())
      .filter((m) => dashboard.METRICS.includes(m));

    if (metrics.length === 0) {
      return ok(res, { series: {}, available: dashboard.METRICS }, 'No metric selected');
    }

    // `to` is exclusive and defaults to the end of today, so today's own
    // numbers appear rather than the chart stopping at midnight.
    const to = req.query.to ? new Date(req.query.to) : new Date();
    to.setHours(23, 59, 59, 999);
    const from = req.query.from
      ? new Date(req.query.from)
      : dashboard.daysAgo(Number(req.query.days) || 29);
    from.setHours(0, 0, 0, 0);

    const series = {};
    await Promise.all(
      metrics.map(async (metric) => {
        series[metric] = await dashboard.series({ metric, from, to });
      })
    );

    return ok(
      res,
      {
        series,
        available: dashboard.METRICS,
        from: from.toISOString(),
        to: to.toISOString(),
      },
      'Analytics'
    );
  })
);

// ── Users ───────────────────────────────────────────────────────────────────

router.get(
  '/users',
  h(async (req, res) => {
    const p = page(req);
    const result = await users.list({
      ...p,
      ...range(req),
      search: str(req.query.search),
      filter: str(req.query.filter) ?? 'all',
      // Independent facets the redesigned Users toolbar filters by — separate
      // from `filter` above (kept for the sidebar's existing shortcut links
      // like "?filter=online") so any combination of type/presence/
      // verification/status can be selected together.
      type: str(req.query.type),
      presence: str(req.query.presence),
      verification: str(req.query.verification),
      status: str(req.query.status),
      sort: str(req.query.sort) ?? 'created_at',
      direction: str(req.query.direction) ?? 'desc',
      includeDeleted: req.query.include_deleted === 'true',
    });
    return listed(res, result, p, 'Users');
  })
);

router.get(
  '/users/:id',
  h(async (req, res) => {
    const data = await users.overview(req.params.id);
    audit.viewedUser(req, req.params.id);
    return ok(res, data, 'User');
  })
);

router.get(
  '/users/:id/activity',
  h(async (req, res) => {
    const p = page(req, 50);
    const result = await users.timeline(req.params.id, {
      ...p,
      ...range(req),
      type: str(req.query.type),
      search: str(req.query.search),
    });
    audit.viewedActivity(req, req.params.id);
    return listed(res, result, p, 'Activity');
  })
);

/** The user's conversations. Opening one is a separate, audited call. */
router.get(
  '/users/:id/messages',
  h(async (req, res) => {
    const p = page(req);
    const result = await messages.listConversations({
      ...p,
      ...range(req),
      userId: req.params.id,
      search: str(req.query.search),
    });
    return listed(res, result, p, 'Conversations');
  })
);

router.get(
  '/users/:id/calls',
  h(async (req, res) => {
    const p = page(req);
    const result = await users.calls(req.params.id, {
      ...p,
      ...range(req),
      type: str(req.query.type),
      status: str(req.query.status),
      search: str(req.query.search),
    });
    return listed(res, result, p, 'Calls');
  })
);

router.get(
  '/users/:id/verification',
  h(async (req, res) => {
    const result = await platform.verificationFeed({ userId: req.params.id, take: 1 });
    return ok(res, { item: result.items[0] ?? null }, 'Verification');
  })
);

router.get(
  '/users/:id/wallet',
  h(async (req, res) => ok(res, { wallet: await users.wallet(req.params.id) }, 'Wallet'))
);

router.get(
  '/users/:id/transactions',
  h(async (req, res) => {
    const p = page(req);
    const result = await users.transactions(req.params.id, {
      ...p,
      ...range(req),
      kind: str(req.query.kind),
      status: str(req.query.status),
      search: str(req.query.search),
    });
    return listed(res, result, p, 'Transactions');
  })
);

router.get(
  '/users/:id/earnings',
  h(async (req, res) => {
    const p = page(req);
    const result = await users.earnings(req.params.id, { ...p, status: str(req.query.status) });
    return listed(res, result, p, 'Earnings');
  })
);

router.get(
  '/users/:id/reports',
  h(async (req, res) => ok(res, await users.reports(req.params.id, page(req)), 'Reports'))
);

router.get('/users/:id/blocks', h(async (req, res) => ok(res, await users.blocks(req.params.id), 'Blocks')));

router.get(
  '/users/:id/notifications',
  h(async (req, res) => {
    const p = page(req);
    const result = await users.notifications(req.params.id, {
      ...p,
      kind: str(req.query.kind),
      unreadOnly: req.query.unread === 'true',
    });
    return listed(res, result, p, 'Notifications');
  })
);

router.get(
  '/users/:id/history',
  h(async (req, res) => {
    const p = page(req, 50);
    const result = await users.accountHistory(req.params.id, p);
    return ok(
      res,
      {
        items: result.items,
        sessions: result.sessions,
        admin_actions: result.admin_actions,
        pagination: {
          page: p.page,
          limit: p.limit,
          total: result.total,
          pages: Math.max(1, Math.ceil(result.total / p.limit)),
        },
      },
      'Account history'
    );
  })
);

/** Suspend, or restore. A reason is required to suspend. */
router.post(
  '/users/:id/status',
  h(async (req, res) => {
    const { status, reason } = req.body ?? {};
    if (!['active', 'suspended'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Status must be active or suspended.',
        error: 'BAD_REQUEST',
      });
    }
    const user = await users.setStatus(req.params.id, { status, reason });
    audit.changedAccountStatus(req, { userId: req.params.id, status, reason });
    return ok(res, { user }, status === 'suspended' ? 'Account suspended' : 'Account restored');
  })
);

/**
 * Ends every session for an account, leaving the account itself alone.
 *
 * Separate from suspension on purpose: "get them off their phone" and "stop
 * this account working" are different decisions, and folding them together
 * means an operator who only wanted the first has to punish the user to get it.
 */
router.post(
  '/users/:id/sign-out',
  h(async (req, res) => {
    const result = await users.signOutEverywhere(req.params.id);
    audit.signedOutEverywhere(req, {
      userId: req.params.id,
      sessions: result.sessions_revoked,
    });
    return ok(
      res,
      result,
      result.sessions_revoked === 0
        ? 'That account had no active sessions'
        : `Signed out of ${result.sessions_revoked} session${result.sessions_revoked === 1 ? '' : 's'}`
    );
  })
);

router.post(
  '/users/:id/wallet/adjust',
  h(async (req, res) => {
    const { balance, rupees, reason } = req.body ?? {};
    const result = await platform.adjustWallet(req.params.id, {
      balance: Number(balance) || 0,
      rupees: Number(rupees) || 0,
      reason,
      reviewer: env.admin.username,
    });
    audit.adjustedWallet(req, {
      userId: req.params.id,
      balance: Number(balance) || 0,
      rupees: Number(rupees) || 0,
      reason,
    });
    return ok(res, result, 'Wallet adjusted');
  })
);

// ── Conversations and messages ──────────────────────────────────────────────

router.get(
  '/conversations',
  h(async (req, res) => {
    const p = page(req);
    const result = await messages.listConversations({
      ...p,
      ...range(req),
      userId: str(req.query.user_id),
      search: str(req.query.search),
    });
    return listed(res, result, p, 'Conversations');
  })
);

/**
 * The contents of one conversation.
 *
 * The single most invasive read in the panel, and the reason the audit log
 * exists. Two people talking privately have no idea an operator can see this,
 * so every open leaves a row naming the conversation and the operator's
 * address.
 */
router.get(
  '/conversations/:id',
  h(async (req, res) => {
    const data = await messages.conversation(req.params.id, {
      before: str(req.query.before),
      limit: Number(req.query.limit) || 50,
    });
    audit.viewedConversation(req, {
      conversationId: req.params.id,
      userId: str(req.query.user_id) ?? data.conversation.participants[0]?.id ?? null,
      messageCount: data.conversation.message_count,
    });
    return ok(res, data, 'Conversation');
  })
);

router.get(
  '/messages',
  h(async (req, res) => {
    const p = page(req);
    const query = str(req.query.search);
    if (!query) {
      // No query means the stats header, not a dump of every message on the
      // platform. Returning all of them would be a page nobody asked for and
      // an audit row that means nothing.
      return ok(res, { stats: await messages.stats(), items: [] }, 'Message activity');
    }

    const result = await messages.searchMessages({
      ...p,
      ...range(req),
      query,
      userId: str(req.query.user_id),
      conversationId: str(req.query.conversation_id),
    });
    audit.searchedMessages(req, { query, scopeUserId: str(req.query.user_id) });
    return listed(res, result, p, 'Messages');
  })
);

router.get('/messages/stats', h(async (_req, res) => ok(res, await messages.stats(), 'Message activity')));

// ── Activity ────────────────────────────────────────────────────────────────

router.get(
  '/activity',
  h(async (req, res) => {
    const p = page(req, 50);
    const result = await platform.activityFeed({
      ...p,
      ...range(req),
      userId: str(req.query.user_id),
      relatedUserId: str(req.query.related_user_id),
      type: str(req.query.type),
      status: str(req.query.status),
      search: str(req.query.search),
    });
    return listed(res, result, p, 'Activity');
  })
);

// ── Calls ───────────────────────────────────────────────────────────────────

router.get(
  '/calls',
  h(async (req, res) => {
    const p = page(req);
    const result = await platform.callFeed({
      ...p,
      ...range(req),
      type: str(req.query.type),
      status: str(req.query.status),
      userId: str(req.query.user_id),
      search: str(req.query.search),
    });
    return listed(res, result, p, 'Calls');
  })
);

router.get('/calls/live', h(async (_req, res) => ok(res, await platform.liveCalls(), 'Live calls')));

router.get(
  '/livekit/rooms',
  h(async (_req, res) => ok(res, await platform.livekitRooms(), 'LiveKit rooms'))
);

// ── Verification ────────────────────────────────────────────────────────────

router.get(
  '/verifications',
  h(async (req, res) => {
    const p = page(req);
    const result = await platform.verificationFeed({
      ...p,
      status: str(req.query.status),
      userId: str(req.query.user_id),
    });
    return listed(res, result, p, 'Verifications');
  })
);

// `:id` is the user id — there is one identity review per account, not one
// per attempt.
router.post(
  '/verifications/:id/decide',
  h(async (req, res) => {
    const { decision, reason } = req.body ?? {};
    const ALLOWED = ['verified', 'rejected'];
    if (!ALLOWED.includes(decision)) {
      return res.status(400).json({
        success: false,
        message: `Decision must be one of ${ALLOWED.join(', ')}.`,
        error: 'BAD_REQUEST',
      });
    }

    const result = await platform.decideVerification(req.params.id, {
      decision,
      reason,
      reviewer: env.admin.username,
    });
    audit.decidedVerification(req, {
      userId: req.params.id,
      decision,
      reason,
    });
    return ok(res, result, 'Verification updated');
  })
);

// ── Moderation ──────────────────────────────────────────────────────────────

router.get(
  '/reports',
  h(async (req, res) => {
    const p = page(req);
    const result = await platform.reportFeed({
      ...p,
      ...range(req),
      status: str(req.query.status),
      userId: str(req.query.user_id),
      search: str(req.query.search),
    });
    return listed(res, result, p, 'Reports');
  })
);

router.post(
  '/reports/:id/resolve',
  h(async (req, res) => {
    const { status, resolution, notes } = req.body ?? {};
    const ALLOWED = ['open', 'reviewing', 'resolved', 'dismissed'];
    if (!ALLOWED.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Status must be one of ${ALLOWED.join(', ')}.`,
        error: 'BAD_REQUEST',
      });
    }
    const result = await platform.resolveReport(req.params.id, {
      status,
      resolution,
      notes,
      reviewer: env.admin.username,
    });
    audit.resolvedReport(req, {
      reportId: req.params.id,
      userId: result.reported_id,
      status,
      resolution,
    });
    return ok(res, result, 'Report updated');
  })
);

router.get(
  '/blocks',
  h(async (req, res) => {
    const p = page(req);
    const result = await platform.blockFeed({ ...p, ...range(req), userId: str(req.query.user_id) });
    return listed(res, result, p, 'Blocks');
  })
);

// ── Finance ─────────────────────────────────────────────────────────────────

router.get(
  '/wallets',
  h(async (req, res) => {
    const p = page(req);
    const result = await platform.walletFeed({
      ...p,
      search: str(req.query.search),
      sort: str(req.query.sort) ?? 'balance',
    });
    return listed(res, result, p, 'Wallets');
  })
);

router.get(
  '/transactions',
  h(async (req, res) => {
    const p = page(req);
    const result = await platform.transactionFeed({
      ...p,
      ...range(req),
      kind: str(req.query.kind),
      status: str(req.query.status),
      userId: str(req.query.user_id),
      search: str(req.query.search),
    });
    return listed(res, result, p, 'Transactions');
  })
);

router.get(
  '/earnings',
  h(async (req, res) => {
    const p = page(req);
    const result = await platform.earningFeed({
      ...p,
      ...range(req),
      status: str(req.query.status),
      userId: str(req.query.user_id),
    });
    return listed(res, result, p, 'Earnings');
  })
);

// ── Catalogue ───────────────────────────────────────────────────────────────
//
// Nothing to administer. Both catalogues the app draws from — cities and
// languages — are static and ship compiled into it, so a row added here could
// never be rendered by an installed build. Changing either is an app release,
// which is what it always actually was.

// ── Notifications ───────────────────────────────────────────────────────────

router.get(
  '/notifications',
  h(async (req, res) => {
    const p = page(req);
    const result = await platform.notificationFeed({
      ...p,
      ...range(req),
      kind: str(req.query.kind),
      userId: str(req.query.user_id),
      unreadOnly: req.query.unread === 'true',
    });
    return listed(res, result, p, 'Notifications');
  })
);

// ── Audit ───────────────────────────────────────────────────────────────────

/**
 * Read-only. There is no write, update or delete route for the audit log
 * anywhere in this file, and that is the point: a log its own subject can
 * rewrite is not a log.
 */
router.get(
  '/audit-logs',
  h(async (req, res) => {
    const p = page(req, 50);
    const result = await platform.auditLog({
      ...p,
      ...range(req),
      action: str(req.query.action),
      userId: str(req.query.user_id),
      targetType: str(req.query.target_type),
      search: str(req.query.search),
    });
    return listed(res, result, p, 'Audit log');
  })
);

module.exports = router;
