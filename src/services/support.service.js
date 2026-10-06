'use strict';

const prisma = require('../config/prisma');
const activity = require('./activity.service');
const { emitToAdmin } = require('../sockets/bus');

/**
 * Help & Support messages.
 *
 * One-way: the app sends a question or a bug report, and it lands in the
 * admin panel's Support inbox. Nothing is sent back from here — an
 * administrator resolves it in the panel (see `admin/platform.service`).
 */

const LABELS = { question: 'a question', bug: 'a bug report' };

async function send(user, { message, category }) {
  const created = await prisma.supportMessage.create({
    data: { userId: user.id, category, message },
  });

  activity.record({
    userId: user.id,
    type: 'support_message',
    relatedEntityId: created.id,
    description: `Sent ${LABELS[category] ?? 'a message'} to support`,
    metadata: { category },
    status: 'open',
  });

  emitToAdmin('admin:support_message', {
    support_message_id: created.id,
    user_id: user.id,
    category,
    at: created.createdAt.toISOString(),
  });

  return created;
}

module.exports = { send };
