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
 * Every send re-checks blocking and both privacy switches. Not once when the
 * conversation opens — either side can switch messaging off or block while a
 * thread is on screen, and the very next message has to see that. The cost is
 * one extra read per send; the alternative is a thread that keeps working
 * after the other person has closed the door.
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
    pinnedField: isA ? 'pinnedByA' : 'pinnedByB',
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
 * The Chats screen: every conversation this account is part of, pinned ones
 * first.
 *
 * Which side's `pinnedByA`/`pinnedByB` flag applies depends on the row, so
 * the pinned-first ordering is done in memory after a single ordered fetch
 * rather than in the query — Node's array sort is stable, so within each
 * group (pinned, then not) rows keep the `lastMessageAt desc` order the query
 * already gave them.
 *
 * With messaging off the answer is an empty list — not an error. The client
 * renders its "Messaging is off" state, and a 403 here would turn a setting
 * into a failure.
 */
async function listThreads(user, { skip, take }) {
  if (user.privacySettings?.allowMessages === false) {
    return { rows: [], total: 0, messagingDisabled: true };
  }

  const blockedIds = await relationship.blockedIdsFor(user.id);
  const blocked = [...blockedIds];

  const where = {
    OR: [{ userAId: user.id }, { userBId: user.id }],
  };
  if (blocked.length > 0) {
    where.NOT = [{ userAId: { in: blocked } }, { userBId: { in: blocked } }];
  }

  const all = await prisma.conversation.findMany({
    where,
    include: {
      ...CONVERSATION_INCLUDE,
      // Only the latest, for the preview line. Loading a whole thread per
      // row to show one line would be pathological on a long list.
      messages: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
    orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
  });

  const isPinned = (c) => (c.userAId === user.id ? c.pinnedByA : c.pinnedByB);
  const sorted = [...all].sort((a, b) => Number(isPinned(b)) - Number(isPinned(a)));

  return { rows: sorted.slice(skip, skip + take), total: sorted.length };
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
 * Marks one recipient's messages delivered.
 *
 * Two callers, two shapes:
 *  - A live ack, scoped to `messageIds` — the recipient's socket just
 *    rendered a `message:new` it received while connected.
 *  - The reconnect catch-up, `messageIds` omitted — everything still `sent`
 *    across every conversation this user is in, swept the moment they come
 *    back online. This is what makes "delivered once they're back online"
 *    true for a message sent while they had no live socket at all: nothing
 *    else ever revisits a `sent` row.
 *
 * Read is a stronger state than delivered, so this only ever touches rows
 * still at `sent` — a message the recipient already opened and read must not
 * be quietly downgraded back to a single tick.
 */
async function markDelivered(user, { messageIds } = {}) {
  const where = {
    status: 'sent',
    senderId: { not: user.id },
    conversation: { OR: [{ userAId: user.id }, { userBId: user.id }] },
  };
  if (messageIds) where.id = { in: messageIds };

  const pending = await prisma.message.findMany({
    where,
    select: { id: true, senderId: true, conversationId: true },
  });
  if (!pending.length) return;

  const now = new Date();
  await prisma.message.updateMany({
    where: { id: { in: pending.map((m) => m.id) } },
    data: { status: 'delivered', deliveredAt: now },
  });

  // One event per conversation, not per message — a sender only has one peer
  // in a given thread, so this is already the coarsest grouping that still
  // lets the client know exactly which bubbles to flip.
  const byConversation = new Map();
  for (const m of pending) {
    const group = byConversation.get(m.conversationId) ?? {
      senderId: m.senderId,
      messageIds: [],
    };
    group.messageIds.push(m.id);
    byConversation.set(m.conversationId, group);
  }
  for (const [conversationId, group] of byConversation) {
    emitToUser(group.senderId, 'message:delivered', {
      conversation_id: conversationId,
      message_ids: group.messageIds,
    });
  }
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

  // A retry of a send that already landed. The first attempt wrote the row and
  // may have died on the way back, so the client has no way to know — it can
  // only send again with the same id, and this is what makes that safe.
  // Returning the original rather than inserting a second copy also means the
  // recipient is not re-notified for a message they already have.
  if (clientId) {
    const already = await prisma.message.findUnique({
      where: { senderId_clientId: { senderId: user.id, clientId } },
    });
    if (already) {
      return {
        message: already,
        conversation: await prisma.conversation.findUnique({
          where: { id: conversationId },
          include: CONVERSATION_INCLUDE,
        }),
      };
    }
  }

  const now = new Date();

  const [message, updatedConversation] = await prisma.$transaction([
    prisma.message.create({
      data: {
        conversationId,
        senderId: user.id,
        clientId: clientId ?? null,
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
  //
  // **Not awaited.** The message is already written and already on its way to
  // the other device — the emits above are what deliver it. `notify` is three
  // more round trips after that: the recipient's notification settings, a row
  // insert, and a recount of their unread badge. Holding the sender's request
  // open for all three is most of the wait between tapping send and the bubble
  // settling, and it bought nothing: the recipient has the message either way.
  //
  // Worse, a throw in there used to fail the *send*. The message was committed
  // and delivered, and the sender was told "Not sent · Tap to retry" — so a
  // retry sent it a second time, and the recipient got it twice.
  const muted = side.isA ? updatedConversation.mutedByB : updatedConversation.mutedByA;
  if (!muted) {
    notificationService
      .notify({
        userId: side.peerId,
        kind: 'message',
        title: user.profile?.name ?? 'New message',
        body: trimmed || attachment?.title || 'Sent an attachment',
        data: { conversation_id: conversationId, user_id: user.id },
      })
      .catch((err) =>
        console.error(`[chat] notify failed for message ${message.id}`, err)
      );
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

/** Pins or unpins a thread for this side only — the other person's list is unaffected. */
async function setPinned(user, conversationId, pinned) {
  const conversation = await getConversationOr404(conversationId, user.id);
  const side = sideOf(conversation, user.id);
  return prisma.conversation.update({
    where: { id: conversationId },
    data: { [side.pinnedField]: pinned },
    include: CONVERSATION_INCLUDE,
  });
}

/** The Chats badge: unread messages across every open conversation. */
async function unreadSummary(user) {
  if (user.privacySettings?.allowMessages === false) {
    return { unread_messages: 0, total: 0 };
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

  return { unread_messages: unreadMessages, total: unreadMessages };
}

/**
 * Opens the conversation with `otherId`, creating it on the spot if these two
 * have never talked before — there is no approval step, only the
 * earner-direction and privacy checks `assertCanStartConversation` runs.
 * Idempotent: calling it again for the same pair just returns the existing
 * thread.
 */
async function openOrCreate(user, otherId) {
  await relationship.assertCanStartConversation(user, otherId);

  const [userAId, userBId] = relationship.orderPair(user.id, otherId);
  const existing = await prisma.conversation.findUnique({
    where: { userAId_userBId: { userAId, userBId } },
  });

  const conversation = await prisma.conversation.upsert({
    where: { userAId_userBId: { userAId, userBId } },
    create: { userAId, userBId },
    update: {},
    include: CONVERSATION_INCLUDE,
  });

  if (!existing) {
    activity.recordPair(
      {
        userId: user.id,
        type: 'conversation_started',
        relatedUserId: otherId,
        relatedEntityId: conversation.id,
        description: 'Started a chat',
      },
      {
        userId: otherId,
        type: 'conversation_started',
        relatedUserId: user.id,
        relatedEntityId: conversation.id,
        description: 'A chat was started with you',
      }
    );
  }

  return conversation;
}

module.exports = {
  listThreads,
  getThread,
  markRead,
  markDelivered,
  sendMessage,
  deleteMessage,
  setMuted,
  setPinned,
  unreadSummary,
  openOrCreate,
  getConversationOr404,
  sideOf,
  CONVERSATION_INCLUDE,
};
