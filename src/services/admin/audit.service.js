'use strict';

const prisma = require('../../config/prisma');

/**
 * What the administrator did.
 *
 * Append-only, and never exposed for editing: a log its own subject can
 * rewrite is not a log. The admin UI reads it and nothing else.
 *
 * The reads matter as much as the writes. Opening somebody's private
 * conversation is not a neutral act — it is the single most invasive thing
 * this panel can do — and it should leave a trace whoever performs it. That
 * is why `viewedConversation` exists alongside `suspendedUser`.
 *
 * Like [activity.service], writing here must never break the operation it
 * describes: the failure is logged, not propagated.
 */

function write({
  action,
  targetType = null,
  targetId = null,
  userId = null,
  description,
  metadata = null,
  req = null,
}) {
  return prisma.adminAuditLog
    .create({
      data: {
        action,
        targetType,
        targetId,
        userId,
        description,
        metadata: metadata ?? undefined,
        ip: req ? clientIp(req) : null,
        userAgent: req?.get?.('user-agent') ?? null,
      },
    })
    .catch((err) => {
      console.error(`[audit] could not record ${action}:`, err.message);
      return null;
    });
}

/**
 * The address the request came from.
 *
 * `req.ip` already respects `trust proxy`, which the app sets — reading
 * `x-forwarded-for` by hand would take the first value a client can spoof.
 */
function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || null;
}

/**
 * Convenience wrappers for the actions worth naming.
 *
 * Named functions rather than string literals at every call site: the audit
 * log is queried by `action`, and a typo would create a category that looks
 * like nothing and hides a real event.
 */
const audit = {
  write,

  login: (req, { username }) =>
    write({
      req,
      action: 'admin.login',
      targetType: 'session',
      description: `Administrator ${username} signed in`,
    }),

  loginFailed: (req, { username, reason }) =>
    write({
      req,
      action: 'admin.login_failed',
      targetType: 'session',
      description: `Failed sign-in for "${username ?? ''}" — ${reason}`,
      metadata: { username: username ?? null },
    }),

  logout: (req) =>
    write({ req, action: 'admin.logout', targetType: 'session', description: 'Administrator signed out' }),

  viewedUser: (req, userId) =>
    write({
      req,
      userId,
      action: 'user.viewed',
      targetType: 'user',
      targetId: userId,
      description: 'Opened a user profile',
    }),

  viewedActivity: (req, userId) =>
    write({
      req,
      userId,
      action: 'user.activity_viewed',
      targetType: 'user',
      targetId: userId,
      description: "Viewed a user's activity timeline",
    }),

  /** The most invasive read in the panel, and the reason this log exists. */
  viewedConversation: (req, { conversationId, userId, messageCount }) =>
    write({
      req,
      userId,
      action: 'conversation.viewed',
      targetType: 'conversation',
      targetId: conversationId,
      description: 'Opened a private conversation',
      metadata: { message_count: messageCount ?? null },
    }),

  searchedMessages: (req, { query, scopeUserId }) =>
    write({
      req,
      userId: scopeUserId ?? null,
      action: 'messages.searched',
      targetType: 'message',
      description: `Searched message content for "${query}"`,
      metadata: { query },
    }),

  decidedVerification: (req, { userId, decision, reason }) =>
    write({
      req,
      userId,
      action: `verification.${decision}`,
      targetType: 'user',
      targetId: userId,
      description: `Identity verification ${decision}${reason ? ` — ${reason}` : ''}`,
      metadata: { decision, reason: reason ?? null },
    }),

  viewedReport: (req, { reportId, userId }) =>
    write({
      req,
      userId,
      action: 'report.viewed',
      targetType: 'report',
      targetId: reportId,
      description: 'Opened a report',
    }),

  resolvedReport: (req, { reportId, userId, status, resolution }) =>
    write({
      req,
      userId,
      action: 'report.resolved',
      targetType: 'report',
      targetId: reportId,
      description: `Report marked ${status}${resolution ? ` — ${resolution}` : ''}`,
      metadata: { status, resolution: resolution ?? null },
    }),

  changedAccountStatus: (req, { userId, status, reason }) =>
    write({
      req,
      userId,
      action: `user.${status}`,
      targetType: 'user',
      targetId: userId,
      description: `Account ${status}${reason ? ` — ${reason}` : ''}`,
      metadata: { status, reason: reason ?? null },
    }),

  signedOutEverywhere: (req, { userId, sessions }) =>
    write({
      req,
      userId,
      action: 'user.signed_out',
      targetType: 'session',
      targetId: userId,
      description: `Signed out of every device — ${sessions} session${sessions === 1 ? '' : 's'} revoked`,
      metadata: { sessions_revoked: sessions },
    }),

  adjustedWallet: (req, { userId, balance, rupees, reason }) =>
    write({
      req,
      userId,
      action: 'wallet.adjusted',
      targetType: 'wallet',
      targetId: userId,
      description: `Wallet adjusted by ${balance ? `₹${balance} balance` : ''}${
        balance && rupees ? ' and ' : ''
      }${rupees ? `₹${rupees} earnings` : ''} — ${reason}`,
      metadata: { balance: balance ?? 0, rupees: rupees ?? 0, reason },
    }),

  changedCatalogue: (req, { entity, id, change }) =>
    write({
      req,
      action: `${entity}.${change}`,
      targetType: entity,
      targetId: id,
      description: `${entity} ${id} ${change}`,
    }),
};

module.exports = audit;
