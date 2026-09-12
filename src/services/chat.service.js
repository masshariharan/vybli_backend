'use strict';

const prisma = require('../config/prisma');
const { errors } = require('../utils/errors');
const relationship = require('./relationship.service');
const notificationService = require('./notification.service');
const activity = require('./activity.service');
const { emitToUser, emitToAdmin } = require('../sockets/bus');
const serialize = require('../utils/serialize');

/**
 * One-to-one messaging.
 *
 * Every send re-checks friendship, blocking and both privacy switches. Not
 * once when the conversation opens — either side can switch messaging off or
 * block while a thread is on screen, and the very next message has to see
 * that. The cost is one extra read per send; the alternative is a thread that
 * keeps working after the other person has closed the door.
 */

const USER_INCLUDE = {
  profile: true,
  privacySettings: true,
};

const CONVERSATION_INCLUDE = {
  userA: { include: USER_INCLUDE },
  userB: { include: USER_INCLUDE },
};

/** Which side of the row the viewer is on. */
function sideOf(conversation, userId) {
  const isA = conversation.userAId === userId;
  return {
    isA,
    peerId: isA ? conversation.userBId : conversation.userAId,
    peer: isA ? conversation.userB : conversation.userA,
    unreadField: isA ? 'unreadForA' : 'unreadForB',
    peerUnreadField: isA ? 'unreadForB' : 'unreadForA',
    mutedField: isA ? 'mutedByA' : 'mutedByB',
  };
}

async function getConversationOr404(conversationId, userId) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: CONVERSATION_INCLUDE,
  });
  if (!conversation) throw errors.notFound('Conversation', 'CONVERSATION_NOT_FOUND');
  // Membership is checked as existence: an id belonging to someone else's
  // thread must read as missing, not forbidden.
  if (conversation.userAId !== userId && conversation.userBId !== userId) {
    throw errors.notFound('Conversation', 'CONVERSATION_NOT_FOUND');
  }
  return conversation;
}

/**
 * The Chats screen.
 *
 * Two tabs, one query each. `accepted` is real conversations; `requests` is
 * the pending gate, which has no conversation row yet and is therefore built
 * from friend requests instead.
 *
 * With messaging off the answer is an empty list for both — not an error. The
 * client renders its "Messaging is off" state, and a 403 here would turn a
 * setting into a failure.
 */
async function listThreads(user, { filter, skip, take }) {
  if (user.privacySettings?.allowMessages === false) {
    return { rows: [], total: 0, messagingDisabled: true };
  }

  const blockedIds = await relationship.blockedIdsFor(user.id);
  const blocked = [...blockedIds];

  if (filter === 'requests') {
    const where = {
      status: 'pending',
      OR: [
        { requesterId: user.id },
        // Only earners have an inbound side at all.
        ...(user.profile?.isEarner ? [{ addresseeId: user.id }] : []),
      ],
    };
    if (blocked.length > 0) {
      where.NOT = [{ requesterId: { in: blocked } }, { addresseeId: { in: blocked } }];
    }

    const [rows, total] = await Promise.all([
      prisma.friendRequest.findMany({
        where,
        include: {
          requester: { include: USER_INCLUDE },
          addressee: { include: USER_INCLUDE },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.friendRequest.count({ where }),
    ]);

    return { rows, total, kind: 'requests' };
  }

  const where = {
    OR: [{ userAId: user.id }, { userBId: user.id }],
  };
  if (blocked.length > 0) {
    where.NOT = [{ userAId: { in: blocked } }, { userBId: { in: blocked } }];
  }

  const [rows, total] = await Promise.all([
    prisma.conversation.findMany({
      where,
      include: {
        ...CONVERSATION_INCLUDE,
        // Only the latest, for the preview line. Loading a whole thread per
        // row to show one line would be pathological on a long list.
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
      skip,
      take,
    }),
    prisma.conversation.count({ where }),
  ]);

  return { rows, total, kind: 'conversations' };
}

/**
 * Opens a thread and marks it read.
 *
 * Reading is what marks it read — the client used to have a `markRead` nobody
 * called, and the badge never cleared. Doing it here means it cannot be
 * forgotten.
 */
async function getThread(user, conversationId, { limit = 50, before } = {}) {
  const conversation = await getConversationOr404(conversationId, user.id);
  const side = sideOf(conversation, user.id);

  if (await relationship.isBlockedEitherWay(user.id, side.peerId)) throw errors.blocked();

  const where = { conversationId, deletedAt: null };
  // Cursor paging: messages arrive while you scroll, and an offset would skip
  // or repeat rows as the list grows underneath.
  if (before) {
    const anchor = await prisma.message.findUnique({
      where: { id: before },
      select: { createdAt: true },
    });
    if (anchor) where.createdAt = { lt: anchor.createdAt };
  }

  const messages = await prisma.message.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  const updated = await markRead(user, conversationId);

  return {
    conversation: updated ?? conversation,
    // Fetched newest-first for the limit, handed back oldest-first for
    // rendering.
    messages: messages.reverse(),
    hasMore: messages.length === limit,
  };
}

/** Zeroes this side's unread counter and tells the sender their message landed. */
async function markRead(user, conversationId) {
  const conversation = await getConversationOr404(conversationId, user.id);
  const side = sideOf(conversation, user.id);

  if (conversation[side.unreadField] === 0) return conversation;

  const [updated] = await prisma.$transaction([
    prisma.conversation.update({
      where: { id: conversationId },
      data: { [side.unreadField]: 0 },
      include: CONVERSATION_INCLUDE,
    }),
    prisma.message.updateMany({
      where: { conversationId, senderId: side.peerId, readAt: null },
      data: { status: 'read', readAt: new Date() },
    }),
  ]);

  emitToUser(side.peerId, 'message:read', {
    conversation_id: conversationId,
    reader_id: user.id,
  });

  activity.record({
    userId: user.id,
    type: 'message_read',
    relatedUserId: side.peerId,
    relatedEntityId: conversationId,
    description: 'Read the conversation',
    metadata: { conversation_id: conversationId },
  });

  return updated;
}

/**
 * Sends a message.
 *
 * The conversation's `lastMessageAt` and the recipient's unread counter move
 * in the same transaction as the insert — a message that exists but does not
 * bump the list would sit invisible at the bottom of the Chats screen.
 */
async function sendMessage(user, conversationId, { text = '', attachment, clientId }) {
  const conversation = await getConversationOr404(conversationId, user.id);
  const side = sideOf(conversation, user.id);

  // The full guard, on every send.
  await relationship.assertCanMessage(user, side.peerId);

  const trimmed = (text ?? '').trim();
  if (!trimmed && !attachment) {
    throw errors.badRequest('Write a message or attach something');
  }

  const now = new Date();

  const [message, updatedConversation] = await prisma.$transaction([
    prisma.message.create({
      data: {
        conversationId,
        senderId: user.id,
        text: trimmed,
        status: 'sent',
        attachmentKind: attachment?.kind ?? null,
        attachmentTitle: attachment?.title ?? null,
        attachmentSubtitle: attachment?.subtitle ?? null,
        attachmentUrl: attachment?.image_url ?? null,
        attachmentDuration: attachment?.duration_label ?? null,
      },
    }),
    prisma.conversation.update({
      where: { id: conversationId },
      data: {
        lastMessageAt: now,
        [side.peerUnreadField]: { increment: 1 },
      },
      include: CONVERSATION_INCLUDE,
    }),
  ]);

  const payload = {
    conversation_id: conversationId,
    // Echoed back so the client can match this to its optimistic bubble
    // instead of rendering the message twice.
    client_id: clientId ?? null,
    message: serialize.message(message, side.peerId),
  };
  emitToUser(side.peerId, 'message:new', payload);

  // The sender's other devices need it too, with the authorship flipped.
  emitToUser(user.id, 'message:sent', {
    conversation_id: conversationId,
    client_id: clientId ?? null,
    message: serialize.message(message, user.id),
  });

  // A muted thread still delivers; it just does not shout.
  const muted = side.isA ? updatedConversation.mutedByB : updatedConversation.mutedByA;
  if (!muted) {
    await notificationService.notify({
      userId: side.peerId,
      kind: 'message',
      title: user.profile?.name ?? 'New message',
      body: trimmed || attachment?.title || 'Sent an attachment',
      data: { conversation_id: conversationId, user_id: user.id },
    });
  }

  // The sender's side only. A "message received" row on the recipient would
  // double every conversation in the global feed, and the recipient's real
  // event is reading it, which markRead records.
  activity.record({
    userId: user.id,
    type: 'message_sent',
    relatedUserId: side.peerId,
    relatedEntityId: message.id,
    description: attachment
      ? `Sent ${attachment.kind === 'image' ? 'a photo' : 'an attachment'}`
      : `Sent a message`,
    metadata: {
      conversation_id: conversationId,
      // Length rather than content: the timeline is a summary, and the
      // message itself is one click away in the conversation view.
      length: trimmed.length,
      has_attachment: Boolean(attachment),
    },
    status: 'sent',
  });

  emitToAdmin('admin:message_sent', {
    conversation_id: conversationId,
    sender: { id: user.id, name: user.profile?.name ?? null },
    recipient_id: side.peerId,
    at: message.createdAt.toISOString(),
  });

  return { message, conversation: updatedConversation };
}

/**
 * Deletes one of your own messages.
 *
 * Soft — the row stays so the other side's thread does not renumber, and the
 * client renders a tombstone.
 */
async function deleteMessage(user, messageId) {
  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message) throw errors.notFound('Message', 'MESSAGE_NOT_FOUND');
  if (message.senderId !== user.id) {
    throw errors.forbidden('You can only delete your own messages.', 'NOT_MESSAGE_SENDER');
  }

  const updated = await prisma.message.update({
    where: { id: messageId },
    data: { deletedAt: new Date(), text: '', attachmentKind: null },
  });

  const conversation = await prisma.conversation.findUnique({
    where: { id: message.conversationId },
  });
  const peerId =
    conversation.userAId === user.id ? conversation.userBId : conversation.userAId;

  emitToUser(peerId, 'message:deleted', {
    conversation_id: message.conversationId,
    message_id: messageId,
  });

  return updated;
}

async function setMuted(user, conversationId, muted) {
  const conversation = await getConversationOr404(conversationId, user.id);
  const side = sideOf(conversation, user.id);
  return prisma.conversation.update({
    where: { id: conversationId },
    data: { [side.mutedField]: muted },
    include: CONVERSATION_INCLUDE,
  });
}

/**
 * The Chats badge: unread messages plus requests awaiting a decision.
 *
 * A request you *sent* is not counted — nothing is waiting on you there.
 */
async function unreadSummary(user) {
  if (user.privacySettings?.allowMessages === false) {
    return { unread_messages: 0, pending_requests: 0, total: 0 };
  }

  const blockedIds = await relationship.blockedIdsFor(user.id);
  const blocked = [...blockedIds];

  const conversations = await prisma.conversation.findMany({
    where: {
      OR: [{ userAId: user.id }, { userBId: user.id }],
      ...(blocked.length > 0
        ? { NOT: [{ userAId: { in: blocked } }, { userBId: { in: blocked } }] }
        : {}),
    },
    select: { userAId: true, unreadForA: true, unreadForB: true },
  });

  const unreadMessages = conversations.reduce(
    (sum, c) => sum + (c.userAId === user.id ? c.unreadForA : c.unreadForB),
    0
  );

  const pendingRequests = user.profile?.isEarner
    ? await prisma.friendRequest.count({
        where: {
          addresseeId: user.id,
          status: 'pending',
          ...(blocked.length > 0 ? { requesterId: { notIn: blocked } } : {}),
        },
      })
    : 0;

  return {
    unread_messages: unreadMessages,
    pending_requests: pendingRequests,
    total: unreadMessages + pendingRequests,
  };
}

/** Finds the thread with one person, for a profile's Message button. */
async function findWithUser(user, otherId) {
  const [userAId, userBId] = relationship.orderPair(user.id, otherId);
  return prisma.conversation.findUnique({
    where: { userAId_userBId: { userAId, userBId } },
    include: CONVERSATION_INCLUDE,
  });
}

module.exports = {
  listThreads,
  getThread,
  markRead,
  sendMessage,
  deleteMessage,
  setMuted,
  unreadSummary,
  findWithUser,
  getConversationOr404,
  sideOf,
  CONVERSATION_INCLUDE,
};
