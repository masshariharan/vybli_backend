'use strict';

const prisma = require('../config/prisma');
const { errors } = require('../utils/errors');
const { emitToUser } = require('../sockets/bus');
const serialize = require('../utils/serialize');
const activity = require('./activity.service');
const push = require('./push.service');

/**
 * Notifications.
 *
 * One entry point, [notify], used by every feature. It writes the row and
 * pushes it down the socket in the same call, so an in-app notification and
 * its history can never disagree.
 *
 * The user's notification settings are honoured **here**, not at each call
 * site. A feature should say "this happened"; whether the user wants to hear
 * about it is one decision made in one place.
 */

/** Which settings column governs which kind. */
const SETTING_FOR_KIND = {
  message: 'messages',
  incomingCall: 'incomingCalls',
  missedCall: 'missedCalls',
  earning: 'earnings',
  wallet: null, // Money always notifies.
  transaction: null,
  system: null,
};

async function wants(userId, kind) {
  const column = SETTING_FOR_KIND[kind];
  if (!column) return true;
  const settings = await prisma.notificationSettings.findUnique({
    where: { userId },
    select: { [column]: true },
  });
  // No row means defaults, and every default except promotions is on.
  return settings ? settings[column] !== false : true;
}

/**
 * Records a notification and delivers it live.
 *
 * Returns null when the user has that kind switched off — callers do not
 * branch on it, they just call.
 */
async function notify({ userId, kind, title, body = '', data = null }) {
  if (!(await wants(userId, kind))) return null;

  const row = await prisma.notification.create({
    data: { userId, kind, title, body, data },
  });

  const payload = serialize.notification(row);
  emitToUser(userId, 'notification:new', payload);

  // The badge count travels with it, so the client never has to re-count.
  const unread = await unreadCount(userId);
  emitToUser(userId, 'notification:count', { unread_count: unread });

  // And to the phone itself, for the case the socket cannot cover: the app
  // closed, swiped away, or asleep.
  //
  // Sent unconditionally rather than only when no socket is connected. A
  // connected socket does not mean anybody is looking — Android keeps the
  // connection alive for a while after the app is backgrounded, and "deliver
  // only if disconnected" is exactly the rule that makes a notification go
  // missing in the seconds that matter most. The client suppresses the
  // banner while it is genuinely in the foreground, where it is showing the
  // message itself; it is the only party that knows.
  //
  // Not awaited, and its failure cannot reach the caller: the notification is
  // already written and already delivered over the socket, and a push that
  // did not send is not a reason for a message to report itself unsent.
  push
    .sendNotification(userId, {
      title,
      body,
      data: { kind, notification_id: row.id, ...(data ?? {}) },
      // One row per conversation rather than one per message. Twenty from the
      // same person replace each other; twenty from twenty people do not.
      collapseKey: data?.conversation_id ? `chat_${data.conversation_id}` : null,
    })
    .catch((err) => console.error(`[push] ${kind} notification for ${userId}`, err));

  // Only account-level ones reach the timeline. Every message and every call
  // already sends a notification, so mirroring all of them would bury the
  // timeline under a second copy of things it already shows — the
  // Notifications tab is the complete record.
  if (kind === 'system') {
    activity.record({
      userId,
      type: 'notification',
      relatedEntityId: row.id,
      description: title,
      metadata: { kind, body },
    });
  }

  return row;
}

async function list(userId, { skip, take, unreadOnly = false }) {
  const where = { userId };
  if (unreadOnly) where.readAt = null;

  const [rows, total] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.notification.count({ where }),
  ]);

  return { rows, total };
}

function unreadCount(userId) {
  return prisma.notification.count({ where: { userId, readAt: null } });
}

async function markRead(userId, notificationId) {
  const row = await prisma.notification.findUnique({ where: { id: notificationId } });
  // Scoped to the owner: an id from another account must read as missing, not
  // as forbidden, which would confirm it exists.
  if (!row || row.userId !== userId) {
    throw errors.notFound('Notification', 'NOTIFICATION_NOT_FOUND');
  }
  if (row.readAt) return row;

  const updated = await prisma.notification.update({
    where: { id: notificationId },
    data: { readAt: new Date() },
  });
  emitToUser(userId, 'notification:count', { unread_count: await unreadCount(userId) });
  return updated;
}

async function markAllRead(userId) {
  const { count } = await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
  emitToUser(userId, 'notification:count', { unread_count: 0 });
  return count;
}

module.exports = { notify, list, unreadCount, markRead, markAllRead };
