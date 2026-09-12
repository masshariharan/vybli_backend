'use strict';

const notificationService = require('../services/notification.service');
const moderationService = require('../services/moderation.service');
const verificationService = require('../services/verification.service');
const serialize = require('../utils/serialize');
const { ok, created, paginated } = require('../utils/respond');
const { q } = require('../middleware/validate');
const { toSkipTake } = require('../validators/common');

/**
 * Notifications, moderation and verification status.
 *
 * Three small surfaces sharing one file rather than three files of forty
 * lines each — none of them has enough behaviour to earn its own.
 */

// ── Notifications ───────────────────────────────────────────────────────────

const notifications = {
  async list(req, res) {
    const params = q(req);
    const { skip, take } = toSkipTake(params);
    const { rows, total } = await notificationService.list(req.userId, {
      skip,
      take,
      unreadOnly: params.unread_only,
    });
    return paginated(res, rows.map(serialize.notification), {
      page: params.page,
      limit: params.limit,
      total,
    });
  },

  async unreadCount(req, res) {
    const count = await notificationService.unreadCount(req.userId);
    return ok(res, { unread_count: count }, 'Unread notifications');
  },

  async markRead(req, res) {
    const row = await notificationService.markRead(req.userId, req.params.id);
    return ok(res, { notification: serialize.notification(row) }, 'Marked as read');
  },

  async markAllRead(req, res) {
    const count = await notificationService.markAllRead(req.userId);
    return ok(res, { marked: count, unread_count: 0 }, 'All caught up');
  },
};

// ── Moderation ──────────────────────────────────────────────────────────────

const moderation = {
  async block(req, res) {
    const result = await moderationService.block(req.user, req.body.user_id);
    return ok(
      res,
      { blocked: true, user_id: req.body.user_id, connection_status: 'none' },
      result.alreadyBlocked ? 'Already blocked' : 'Blocked'
    );
  },

  async unblock(req, res) {
    await moderationService.unblock(req.user, req.params.id);
    return ok(res, { unblocked: true, user_id: req.params.id }, 'Unblocked');
  },

  async listBlocked(req, res) {
    const params = q(req);
    const { skip, take } = toSkipTake(params);
    const { rows, total } = await moderationService.listBlocked(req.user, {
      skip,
      take,
    });
    return paginated(
      res,
      rows.map((u) => serialize.userSummary(u)),
      { page: params.page, limit: params.limit, total }
    );
  },

  async report(req, res) {
    const result = await moderationService.report(req.user, {
      userId: req.body.user_id,
      reason: req.body.reason,
      details: req.body.details,
      alsoBlock: req.body.also_block,
    });
    return created(
      res,
      { report_id: result.report.id, blocked: result.blocked },
      result.blocked
        ? 'Report submitted and user blocked'
        : 'Report submitted — our safety team reviews every report within 24 hours'
    );
  },
};

// ── Verification ────────────────────────────────────────────────────────────
// Read-only: there is nothing left for a client to submit. Review is manual,
// see `verification.service`.

const verification = {
  async status(req, res) {
    const status = await verificationService.status(req.user);
    return ok(res, status, 'Verification status');
  },
};

module.exports = { notifications, moderation, verification };
