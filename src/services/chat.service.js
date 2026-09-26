'use strict';

const crypto = require('node:crypto');
const { Prisma } = require('@prisma/client');
const prisma = require('../config/prisma');
const { errors } = require('../utils/errors');
const relationship = require('./relationship.service');
const { pageAcrossBuckets } = require('../utils/paging');
const notificationService = require('./notification.service');
const push = require('./push.service');
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
    deletedField: isA ? 'deletedAtByA' : 'deletedAtByB',
    deletedAt: isA ? conversation.deletedAtByA : conversation.deletedAtByB,
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
 * The Chats screen, one page at a time: every conversation this account is
 * part of, pinned ones first, then most recent.
 *
 * All of it is decided in the query. This used to fetch *every* conversation
 * the account had — each with its latest message — filter out the deleted
 * ones and sort pinned-first in JavaScript, and only then slice out the page
 * asked for, so the twentieth page cost as much as the whole list and the
 * first page as much as the twentieth.
 *
 * What made the query hard is that both rules are per side: "pinned" is
 * `pinnedByA` or `pinnedByB`, and "deleted for me" is `deletedAtByA` or
 * `deletedAtByB`, depending on which column the viewer sits in. So each rule
 * is written once per side and OR'd together ([sideWhere]), and pinned-first
 * becomes two buckets — pinned, then the rest — paged across as one list
 * (`utils/paging`).
 *
 * `unreadTotal` is the unread count across *every* visible conversation, not
 * just this page: the app's badge cannot add up threads it has not loaded.
 *
 * With messaging off the answer is an empty list — not an error. The client
 * renders its "Messaging is off" state, and a 403 here would turn a setting
 * into a failure.
 */
async function listThreads(user, { skip, take }) {
  if (user.privacySettings?.allowMessages === false) {
    return { rows: [], total: 0, unreadTotal: 0, messagingDisabled: true };
  }

  const blocked = [...(await relationship.blockedIdsFor(user.id))];
  const notBlocked =
    blocked.length > 0
      ? { NOT: [{ userAId: { in: blocked } }, { userBId: { in: blocked } }] }
      : {};

  const bucket = (pinned) => ({
    where: {
      AND: [
        notBlocked,
        {
          OR: [
            sideWhere(user.id, 'A', { pinned }),
            sideWhere(user.id, 'B', { pinned }),
          ],
        },
      ],
    },
    orderBy: [
      { lastMessageAt: { sort: 'desc', nulls: 'last' } },
      { createdAt: 'desc' },
      { id: 'desc' },
    ],
  });

  const [{ rows, total }, unreadTotal] = await Promise.all([
    pageAcrossBuckets(prisma.conversation, {
      buckets: [bucket(true), bucket(false)],
      include: {
        ...CONVERSATION_INCLUDE,
        // Only the latest, for the preview line. Loading a whole thread per
        // row to show one line would be pathological on a long list.
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      skip,
      take,
    }),
    unreadTotalFor(user.id, notBlocked),
  ]);

  return { rows, total, unreadTotal };
}

/**
 * The conversations where the viewer is on side [side] ('A' or 'B') and can
 * see the thread — optionally only those they have (or have not) pinned.
 *
 * "Can see" is the delete-for-me rule: a chat this side deleted stays out of
 * the list until something newer than the deletion arrives, and then it comes
 * back holding only that. `lastMessageAt > deletedAtBy<side>` compares two
 * columns of the same row, which Prisma expresses as a field reference.
 */
function sideWhere(userId, side, { pinned } = {}) {
  const deletedField = side === 'A' ? 'deletedAtByA' : 'deletedAtByB';
  const where = {
    [side === 'A' ? 'userAId' : 'userBId']: userId,
    OR: [
      { [deletedField]: null },
      { lastMessageAt: { gt: prisma.conversation.fields[deletedField] } },
    ],
  };
  if (pinned !== undefined) where[side === 'A' ? 'pinnedByA' : 'pinnedByB'] = pinned;
  return where;
}

/** Unread messages across every conversation the viewer can see. */
async function unreadTotalFor(userId, notBlocked) {
  const [asA, asB] = await Promise.all([
    prisma.conversation.aggregate({
      where: { AND: [notBlocked, sideWhere(userId, 'A')] },
      _sum: { unreadForA: true },
    }),
    prisma.conversation.aggregate({
      where: { AND: [notBlocked, sideWhere(userId, 'B')] },
      _sum: { unreadForB: true },
    }),
  ]);
  return (asA._sum.unreadForA ?? 0) + (asB._sum.unreadForB ?? 0);
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
  // Nothing from before this side deleted the chat.
  const createdAt = {};
  if (side.deletedAt) createdAt.gt = side.deletedAt;
  // Cursor paging: messages arrive while you scroll, and an offset would skip
  // or repeat rows as the list grows underneath.
  if (before) {
    const anchor = await prisma.message.findUnique({
      where: { id: before },
      select: { createdAt: true },
    });
    if (anchor) createdAt.lt = anchor.createdAt;
  }
  if (Object.keys(createdAt).length > 0) where.createdAt = createdAt;

  const messages = await prisma.message.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  const updated = await markRead(user, conversation);

  return {
    conversation: updated ?? conversation,
    // Fetched newest-first for the limit, handed back oldest-first for
    // rendering.
    messages: messages.reverse(),
    hasMore: messages.length === limit,
  };
}

/**
 * Zeroes this side's unread counter, marks the peer's messages read, and
 * tells both people.
 *
 * The receipt names the messages it covers (`message_ids`), rather than
 * meaning "everything you ever sent here". The sender's app can have a
 * message still on its way — its bubble not yet swapped for the stored one —
 * and a blanket "all read" turned that one blue before it had even arrived;
 * an id list says exactly which ticks go blue, and lets the app hold on to a
 * receipt for a bubble it has not matched up yet (see the client's
 * `ChatController`).
 *
 * Decided by the unread *messages*, not only the counter: a thread whose
 * counter is already zero can still hold unread rows — a conversation
 * re-pointed after a number was reused starts this side at zero — and those
 * would otherwise never turn blue at all.
 *
 * Read implies delivered, so a message read before its delivery ack ever
 * arrived gets its `deliveredAt` too.
 *
 * The reader's own other devices are told as well (`conversation:read`), so
 * reading on one phone clears the badge on the other.
 */
async function markRead(user, conversationOrId) {
  // A caller that has just loaded the conversation (opening a thread) hands
  // it over rather than have it read twice.
  const conversation =
    typeof conversationOrId === 'string'
      ? await getConversationOr404(conversationOrId, user.id)
      : conversationOrId;
  const conversationId = conversation.id;
  const side = sideOf(conversation, user.id);
  const now = new Date();

  // One statement marks the peer's unread messages read — and delivered, if
  // their delivery ack never made it — and says which ones it touched. It used
  // to be a lookup, two updates and a transaction around them: five round
  // trips between the reader opening the chat and the sender's ticks turning
  // blue. The unread counter is reset alongside it, not after it; the two are
  // independent and each is safe to repeat.
  const [read] = await Promise.all([
    prisma.$queryRaw`
      UPDATE "messages"
      SET "status" = 'read', "readAt" = ${now},
          "deliveredAt" = COALESCE("deliveredAt", ${now})
      WHERE "conversationId" = ${conversationId}
        AND "senderId" = ${side.peerId}
        AND "readAt" IS NULL
      RETURNING "id"`,
    conversation[side.unreadField] > 0
      ? prisma.conversation.update({
          where: { id: conversationId },
          data: { [side.unreadField]: 0 },
          select: { id: true },
        })
      : null,
  ]);
  const ids = read.map((r) => r.id);
  if (ids.length === 0 && conversation[side.unreadField] === 0) return conversation;
  const updated = { ...conversation, [side.unreadField]: 0 };

  if (ids.length > 0) {
    emitToUser(side.peerId, 'message:read', {
      conversation_id: conversationId,
      reader_id: user.id,
      message_ids: ids,
      read_at: now.toISOString(),
    });
  }
  emitToUser(user.id, 'conversation:read', { conversation_id: conversationId });

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
  if (messageIds && messageIds.length === 0) return;
  const now = new Date();

  // One statement: flip, and say what was flipped. It used to be a lookup and
  // then an update — two round trips before the sender's second tick could
  // even be sent. Only rows still at `sent`, only other people's messages,
  // and only in conversations this user is part of.
  const pending = await prisma.$queryRaw`
    UPDATE "messages" AS m
    SET "status" = 'delivered', "deliveredAt" = ${now}
    FROM "conversations" AS c
    WHERE m."conversationId" = c."id"
      AND m."status" = 'sent'
      AND m."senderId" <> ${user.id}
      AND (c."userAId" = ${user.id} OR c."userBId" = ${user.id})
      AND (${messageIds ?? null}::text[] IS NULL OR m."id" = ANY(${messageIds ?? null}::text[]))
    RETURNING m."id" AS "id", m."senderId" AS "senderId", m."conversationId" AS "conversationId"`;
  if (!pending.length) return;

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
      delivered_at: now.toISOString(),
    });
  }
}

/**
 * A message id, made here because the send writes its row with one raw
 * statement and so skips Prisma's `@default(cuid())`. Same shape as a cuid —
 * `c`, a time part, then randomness — so ids made either way sort and read
 * alike; unique by the 16 random bytes, not by the clock.
 */
function newId() {
  return `c${Date.now().toString(36)}${crypto.randomBytes(12).toString('base64url')}`;
}

/** Postgres's unique-violation, however the driver adapter wraps it. */
function isUniqueViolation(error) {
  return (
    error?.code === 'P2002' ||
    error?.meta?.code === '23505' ||
    error?.cause?.code === '23505' ||
    /23505|unique constraint/i.test(error?.message ?? '')
  );
}

/**
 * Sends a message.
 *
 * The conversation's `lastMessageAt` and the recipient's unread counter move
 * in the same transaction as the insert — a message that exists but does not
 * bump the list would sit invisible at the bottom of the Chats screen.
 *
 * **Every database round trip here is time the sender watches "sending…".**
 * Against a database a quarter-second away this was twenty-two of them — the
 * same two people loaded three times over — so the path is kept to what it
 * needs, in as few sequential steps as the data allows: the conversation (with
 * both people, which is everything the guard needs), then the block check and
 * the retry lookup side by side, then the write.
 */
async function sendMessage(user, conversationId, { text = '', attachment, clientId }) {
  const trimmed = (text ?? '').trim();
  if (!trimmed && !attachment) {
    throw errors.badRequest('Write a message or attach something');
  }

  const conversation = await getConversationOr404(conversationId, user.id);
  const side = sideOf(conversation, user.id);

  // A retry of a send that already landed. The first attempt wrote the row and
  // may have died on the way back, so the client has no way to know — it can
  // only send again with the same id, and this is what makes that safe.
  // Returning the original rather than inserting a second copy also means the
  // recipient is not re-notified for a message they already have.
  //
  // Looked up alongside the guard rather than after it — the two do not
  // depend on each other — but only used once the guard has passed.
  const [, already] = await Promise.all([
    // The full guard, on every send, against the peer the conversation
    // already loaded.
    relationship.assertCanMessageLoaded(user, side.peer),
    clientId
      ? prisma.message.findUnique({
          where: { senderId_clientId: { senderId: user.id, clientId } },
        })
      : null,
  ]);
  if (already) return { message: already };

  const now = new Date();

  // The insert and the conversation bump in **one statement** — Postgres runs
  // a statement's data-modifying CTEs atomically, so it is exactly as
  // all-or-nothing as the transaction it replaces, in one round trip instead
  // of four (BEGIN, INSERT, UPDATE, COMMIT). The unread column is one of two
  // fixed names, never input, so naming it with `Prisma.raw` is safe.
  const unreadColumn = Prisma.raw(`"${side.peerUnreadField}"`);
  let rows;
  try {
    rows = await prisma.$queryRaw`
      WITH m AS (
        INSERT INTO "messages" (
          "id", "conversationId", "senderId", "clientId", "text", "status",
          "attachmentKind", "attachmentTitle", "attachmentSubtitle",
          "attachmentUrl", "attachmentDuration", "createdAt"
        ) VALUES (
          ${newId()}, ${conversationId}, ${user.id}, ${clientId ?? null}, ${trimmed},
          'sent', ${attachment?.kind ?? null}::"AttachmentKind",
          ${attachment?.title ?? null}, ${attachment?.subtitle ?? null},
          ${attachment?.image_url ?? null}, ${attachment?.duration_label ?? null},
          ${now}
        )
        RETURNING *
      ), c AS (
        UPDATE "conversations"
        SET "lastMessageAt" = ${now}, ${unreadColumn} = ${unreadColumn} + 1,
            "updatedAt" = ${now}
        WHERE "id" = ${conversationId}
        RETURNING "mutedByA", "mutedByB"
      )
      SELECT m.*, c."mutedByA" AS "_mutedByA", c."mutedByB" AS "_mutedByB"
      FROM m, c`;
  } catch (error) {
    // Two copies of the same retry racing each other: the other one stored
    // it first. Answer with that, as the lookup above would have.
    if (clientId && isUniqueViolation(error)) {
      const stored = await prisma.message.findUnique({
        where: { senderId_clientId: { senderId: user.id, clientId } },
      });
      if (stored) return { message: stored };
    }
    throw error;
  }
  const { _mutedByA, _mutedByB, ...message } = rows[0];
  const updatedConversation = { mutedByA: _mutedByA, mutedByB: _mutedByB };

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
  //
  // The push carries the message id either way: a phone that receives it with
  // the app closed acknowledges delivery from the push itself
  // (`POST /conversations/messages/delivered`), so the sender's second tick
  // does not wait for the app to be opened. A muted thread gets the same
  // acknowledgement from a silent, data-only push that shows nothing.
  const muted = side.isA ? updatedConversation.mutedByB : updatedConversation.mutedByA;
  if (!muted) {
    notificationService
      .notify({
        userId: side.peerId,
        kind: 'message',
        title: user.profile?.name ?? 'New message',
        body: trimmed || attachment?.title || 'Sent an attachment',
        data: { conversation_id: conversationId, user_id: user.id, message_id: message.id },
      })
      .catch((err) =>
        console.error(`[chat] notify failed for message ${message.id}`, err)
      );
  } else {
    push
      .sendSilent(side.peerId, {
        kind: 'message_silent',
        conversation_id: conversationId,
        message_id: message.id,
      })
      .catch((err) =>
        console.error(`[chat] silent push failed for message ${message.id}`, err)
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

  return { message };
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

/**
 * Deletes the chat for this side only.
 *
 * Nothing is removed from the database. The conversation and its messages
 * belong to both people, and the other person's copy must not change because
 * of this. This side's view is cut off at this moment instead: the thread
 * leaves the list, its history is gone, its unread count is cleared and it is
 * unpinned. If the other person writes again, the thread comes back with
 * only what is new, which is how deleting a chat works everywhere else.
 */
async function deleteForMe(user, conversationId) {
  const conversation = await getConversationOr404(conversationId, user.id);
  const side = sideOf(conversation, user.id);
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      [side.deletedField]: new Date(),
      [side.unreadField]: 0,
      [side.pinnedField]: false,
    },
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
  deleteForMe,
  unreadSummary,
  openOrCreate,
  getConversationOr404,
  sideOf,
  CONVERSATION_INCLUDE,
};
