'use strict';

const chatService = require('../services/chat.service');
const serialize = require('../utils/serialize');
const { ok, created, paginated } = require('../utils/respond');
const { q } = require('../middleware/validate');
const { toSkipTake } = require('../validators/common');

/** The Chats screen: every open conversation, pinned ones first. */
async function listThreads(req, res) {
  const params = q(req);
  const { skip, take } = toSkipTake(params);

  const { rows, total, unreadTotal, messagingDisabled } = await chatService.listThreads(req.user, {
    skip,
    take,
  });

  // Messaging off is an empty list with a reason, not an error — the client
  // has a state for it, and a 403 would turn a setting into a failure.
  if (messagingDisabled) {
    return ok(
      res,
      {
        items: [],
        pagination: {
          page: params.page,
          limit: params.limit,
          total: 0,
          total_pages: 0,
          has_next: false,
          has_previous: false,
        },
        messaging_disabled: true,
        unread_total: 0,
      },
      'Messaging is off'
    );
  }

  const items = rows.map((c) =>
    serialize.chatThread(c, req.userId, { messages: c.messages ?? [] })
  );

  return paginated(
    res,
    items,
    { page: params.page, limit: params.limit, total },
    'Conversations',
    // Across every conversation, not this page — see `listThreads`.
    { unread_total: unreadTotal }
  );
}

/** Opens a thread. Reading it is what marks it read. */
async function getThread(req, res) {
  const params = q(req);
  const { conversation, messages, hasMore } = await chatService.getThread(
    req.user,
    req.params.id,
    { limit: params.limit ?? 50, before: params.before }
  );

  return ok(
    res,
    {
      thread: serialize.chatThread(conversation, req.userId, { messages }),
      has_more: hasMore,
    },
    'Conversation'
  );
}

async function sendMessage(req, res) {
  const { message } = await chatService.sendMessage(req.user, req.params.id, {
    text: req.body.text,
    attachment: req.body.attachment,
    clientId: req.body.client_id,
    envelope: req.body.envelope,
  });

  return created(
    res,
    {
      message: serialize.message(message, req.userId),
      client_id: req.body.client_id ?? null,
    },
    'Sent'
  );
}

/**
 * The delivery ack from a push — the app was closed, so there was no socket to
 * ack on. Idempotent, and only ever moves the caller's *received* messages
 * from `sent` to `delivered` (see `chatService.markDelivered`).
 */
async function markDelivered(req, res) {
  await chatService.markDelivered(req.user, { messageIds: req.body.message_ids });
  return ok(res, { delivered: true }, 'Delivered');
}

/**
 * The same ack, proven by the push's own receipt instead of a sign-in — what
 * the phone's background handler sends, because a background refresh would
 * rotate the session out from under the app still in memory.
 */
async function markDeliveredByReceipt(req, res) {
  await chatService.markDeliveredByReceipt({
    messageId: req.body.message_id,
    recipientId: req.body.recipient_id,
    receipt: req.body.receipt,
  });
  return ok(res, { delivered: true }, 'Delivered');
}

async function markRead(req, res) {
  const conversation = await chatService.markRead(req.user, req.params.id);
  return ok(
    res,
    { conversation_id: conversation.id, unread_count: 0 },
    'Marked as read'
  );
}

async function deleteMessage(req, res) {
  await chatService.deleteMessage(req.user, req.params.id);
  return ok(res, { deleted: true }, 'Message deleted');
}

async function setMuted(req, res) {
  const conversation = await chatService.setMuted(
    req.user,
    req.params.id,
    req.body.muted
  );
  return ok(
    res,
    { conversation_id: conversation.id, muted: req.body.muted },
    req.body.muted ? 'Notifications muted' : 'Notifications on'
  );
}

async function setPinned(req, res) {
  const conversation = await chatService.setPinned(
    req.user,
    req.params.id,
    req.body.pinned
  );
  return ok(
    res,
    { conversation_id: conversation.id, pinned: req.body.pinned },
    req.body.pinned ? 'Chat pinned' : 'Chat unpinned'
  );
}

/** The chat's disappearing-messages timer — see `chatService.setMessageTimer`. */
async function setMessageTimer(req, res) {
  const conversation = await chatService.setMessageTimer(req.user, req.params.id, req.body.hours);
  return ok(
    res,
    { conversation_id: conversation.id, message_ttl_hours: conversation.messageTtlHours },
    req.body.hours === 24
      ? 'New messages will disappear after 24 hours'
      : 'New messages will disappear after 7 days'
  );
}

/** The chat's theme, for both people — see `chatService.setChatTheme`. */
async function setChatTheme(req, res) {
  const conversation = await chatService.setChatTheme(req.user, req.params.id, req.body.theme);
  return ok(
    res,
    { conversation_id: conversation.id, chat_theme: conversation.chatTheme },
    'Chat theme updated'
  );
}

/** Deletes the chat for this side only — see `chatService.deleteForMe`. */
async function deleteConversation(req, res) {
  await chatService.deleteForMe(req.user, req.params.id);
  return ok(res, { conversation_id: req.params.id }, 'Chat deleted');
}

/** The Chats tab badge. */
async function unreadSummary(req, res) {
  const summary = await chatService.unreadSummary(req.user);
  return ok(res, summary, 'Unread summary');
}

/** Opens (creating if needed) the conversation with one person — the Chat button. */
async function openConversation(req, res) {
  const conversation = await chatService.openOrCreate(req.user, req.params.id);
  return ok(
    res,
    { thread: serialize.chatThread(conversation, req.userId, { messages: [] }) },
    'Conversation'
  );
}

module.exports = {
  listThreads,
  getThread,
  sendMessage,
  markRead,
  markDelivered,
  markDeliveredByReceipt,
  deleteMessage,
  setMuted,
  setPinned,
  setMessageTimer,
  setChatTheme,
  deleteConversation,
  unreadSummary,
  openConversation,
};
