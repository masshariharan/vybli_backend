'use strict';

const prisma = require('../../config/prisma');
const { errors } = require('../../utils/errors');
const { summarise, PROFILE_INCLUDE } = require('./users.service');

/**
 * Conversations and their contents.
 *
 * This is the most invasive surface in the panel, and it is treated that way.
 * The platform owner needs to be able to read a reported conversation — that
 * is what moderation *is* — but two people talking privately have no idea an
 * operator can see it, so:
 *
 *  * every route here is behind the admin session like the rest, and
 *  * **opening a conversation and searching message content are both audited**
 *    by the controller, with the conversation id and the message count.
 *
 * The audit call lives in the controller rather than here so this stays a
 * pure query layer, but it is not optional: the endpoint that skips it is the
 * one that makes the log a lie.
 *
 * Nothing on this page is reachable by a mobile client. The user-facing chat
 * API only ever returns conversations the requester is a participant in.
 */

const CONVERSATION_INCLUDE = {
  userA: { include: PROFILE_INCLUDE },
  userB: { include: PROFILE_INCLUDE },
  _count: { select: { messages: true } },
};

function serializeConversation(c) {
  return {
    id: c.id,
    participants: [summarise(c.userA), summarise(c.userB)],
    message_count: c._count?.messages ?? 0,
    last_message_at: c.lastMessageAt?.toISOString() ?? null,
    unread_a: c.unreadA,
    unread_b: c.unreadB,
    created_at: c.createdAt.toISOString(),
    // A conversation nobody has written in for a month reads differently from
    // one that is live, and that is the first thing an operator wants to know.
    status: c.lastMessageAt
      ? Date.now() - c.lastMessageAt.getTime() < 7 * 86400_000
        ? 'active'
        : 'dormant'
      : 'empty',
  };
}

function serializeMessage(m) {
  return {
    id: m.id,
    conversation_id: m.conversationId,
    sender: m.sender
      ? {
          id: m.sender.id,
          name: m.sender.profile?.name ?? null,
          avatar_url: m.sender.profile?.avatarUrl ?? null,
        }
      : { id: m.senderId, name: null, avatar_url: null },
    // The recipient is the other side of the conversation, not a column —
    // a two-person thread makes it derivable and storing it would be a second
    // place for it to be wrong.
    recipient_id: m.recipientId ?? null,
    text: m.deletedAt ? null : m.text,
    attachment:
      m.deletedAt || !m.attachmentKind
        ? null
        : {
            kind: m.attachmentKind,
            title: m.attachmentTitle,
            subtitle: m.attachmentSubtitle,
            url: m.attachmentUrl,
            duration: m.attachmentDuration,
          },
    status: m.status,
    is_deleted: Boolean(m.deletedAt),
    read_at: m.readAt?.toISOString() ?? null,
    created_at: m.createdAt.toISOString(),
  };
}

/** Every conversation, or every conversation involving one person. */
async function listConversations({ userId, search, from, to, skip = 0, take = 25 } = {}) {
  const where = {};
  if (userId) where.OR = [{ userAId: userId }, { userBId: userId }];
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }
  if (search) {
    const byName = {
      OR: [
        { userA: { profile: { name: { contains: search, mode: 'insensitive' } } } },
        { userB: { profile: { name: { contains: search, mode: 'insensitive' } } } },
        { id: search },
      ],
    };
    where.AND = [...(where.AND ?? []), byName];
  }

  const [rows, total] = await Promise.all([
    prisma.conversation.findMany({
      where,
      include: CONVERSATION_INCLUDE,
      // Most recently used first. `createdAt` as the tiebreak, so a
      // conversation with no messages still has a stable position.
      orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
      skip,
      take,
    }),
    prisma.conversation.count({ where }),
  ]);

  return { items: rows.map(serializeConversation), total };
}

/**
 * One conversation's messages.
 *
 * Paginated with a cursor rather than an offset. Chat history is read
 * newest-first and scrolled backwards, and an offset walks the whole prefix
 * every time somebody scrolls up — on a long thread that is the query that
 * eventually times out.
 */
async function conversation(conversationId, { before, limit = 50 } = {}) {
  const row = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: CONVERSATION_INCLUDE,
  });
  if (!row) throw errors.notFound('Conversation', 'CONVERSATION_NOT_FOUND');

  const where = { conversationId };
  if (before) where.createdAt = { lt: new Date(before) };

  const rows = await prisma.message.findMany({
    where,
    include: { sender: { include: { profile: true } } },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 200),
  });

  // Oldest-first for rendering; the query runs newest-first so the cursor
  // works, and reversing 50 rows costs nothing.
  const messages = rows.reverse().map((m) => {
    const recipientId = m.senderId === row.userAId ? row.userBId : row.userAId;
    return serializeMessage({ ...m, recipientId });
  });

  return {
    conversation: serializeConversation(row),
    messages,
    // Null when this page was not full — there is nothing older.
    next_before: rows.length === Math.min(limit, 200) ? messages[0]?.created_at ?? null : null,
    has_more: rows.length === Math.min(limit, 200),
  };
}

/**
 * Searches message text.
 *
 * Audited by the caller. Reading one flagged conversation is moderation;
 * grepping every message on the platform for a word is a different thing, and
 * the log is what makes the difference visible afterwards.
 */
async function searchMessages({ query, userId, conversationId, from, to, skip = 0, take = 25 }) {
  if (!query || query.trim().length < 2) {
    throw errors.badRequest('Enter at least two characters to search messages.');
  }

  const where = {
    text: { contains: query.trim(), mode: 'insensitive' },
    deletedAt: null,
  };
  if (conversationId) where.conversationId = conversationId;
  if (userId) {
    where.conversation = { OR: [{ userAId: userId }, { userBId: userId }] };
  }
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }

  const [rows, total] = await Promise.all([
    prisma.message.findMany({
      where,
      include: {
        sender: { include: { profile: true } },
        conversation: { include: CONVERSATION_INCLUDE },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.message.count({ where }),
  ]);

  return {
    items: rows.map((m) => ({
      ...serializeMessage(m),
      conversation: serializeConversation(m.conversation),
    })),
    total,
  };
}

/** The counters on the Message Activity page. */
async function stats() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const week = new Date(today);
  week.setDate(week.getDate() - 7);
  const month = new Date(today);
  month.setDate(month.getDate() - 30);

  const [conversations, active, messages, todayCount, weekCount, monthCount, deleted] =
    await Promise.all([
      prisma.conversation.count(),
      prisma.conversation.count({ where: { lastMessageAt: { gte: week } } }),
      prisma.message.count(),
      prisma.message.count({ where: { createdAt: { gte: today } } }),
      prisma.message.count({ where: { createdAt: { gte: week } } }),
      prisma.message.count({ where: { createdAt: { gte: month } } }),
      prisma.message.count({ where: { deletedAt: { not: null } } }),
    ]);

  return {
    conversations,
    active_conversations: active,
    messages,
    messages_today: todayCount,
    messages_this_week: weekCount,
    messages_this_month: monthCount,
    deleted_messages: deleted,
  };
}

module.exports = {
  listConversations,
  conversation,
  searchMessages,
  stats,
  serializeConversation,
  serializeMessage,
};
