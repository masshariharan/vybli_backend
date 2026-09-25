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

  const { rows, total, messagingDisabled } = await chatService.listThreads(req.user, {
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
      },
      'Messaging is off'
    );
  }

  const items = rows.map((c) =>
    serialize.chatThread(c, req.userId, { messages: c.messages ?? [] })
  );

  return paginated(res, items, { page: params.page, limit: params.limit, total });
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
  deleteMessage,
  setMuted,
  setPinned,
  deleteConversation,
  unreadSummary,
  openConversation,
};
