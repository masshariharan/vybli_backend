'use strict';

const prisma = require('../config/prisma');
const activity = require('./activity.service');
const { errors } = require('../utils/errors');
const relationship = require('./relationship.service');
const { emitToUser, emitToAdmin } = require('../sockets/bus');

/**
 * Blocking and reporting.
 *
 * Blocking is a **full severance**, not a discovery filter. That distinction
 * is the whole point: hiding someone's card while leaving their conversation
 * live, their messages arriving and their calls ringing is not a block, and it
 * was exactly the gap the client had before its audit. So a block also ends
 * any live call between the two, and every read/write on their conversation
 * — `assertCanInteract` and `getThread` both check it on every request.
 */

async function block(user, targetId) {
  if (user.id === targetId) throw errors.badRequest('You cannot block yourself');

  const target = await relationship.loadCounterpart(targetId);

  const existing = await prisma.block.findUnique({
    where: { blockerId_blockedId: { blockerId: user.id, blockedId: targetId } },
  });
  if (existing) return { blocked: true, alreadyBlocked: true, user: target };

  await prisma.block.create({ data: { blockerId: user.id, blockedId: targetId } });

  // A call in progress ends now — waiting for it to finish would mean the
  // block does nothing about the very thing prompting it. Required lazily to
  // avoid a cycle: the call service reaches back into relationship checks.
  const callService = require('./call.service');
  const live = await prisma.call.findFirst({
    where: {
      status: { in: ['ringing', 'connected'] },
      OR: [
        { callerId: user.id, calleeId: targetId },
        { callerId: targetId, calleeId: user.id },
      ],
    },
    include: callService.CALL_INCLUDE,
  });
  if (live) {
    await callService.end(user, live.id, { reason: 'cancelled', force: true });
  }

  emitToUser(targetId, 'user:blocked_by', { user_id: user.id });
  activity.record({
    userId: user.id,
    type: 'block',
    relatedUserId: targetId,
    description: `Blocked ${activity.nameOf(target)}`,
    status: 'active',
  });

  return { blocked: true, user: target };
}

/**
 * Unblocks. Only lifts the block itself — the conversation, if there is one,
 * simply becomes reachable again.
 */
async function unblock(user, targetId) {
  const { count } = await prisma.block.deleteMany({
    where: { blockerId: user.id, blockedId: targetId },
  });
  if (count === 0) throw errors.notFound('Block', 'NOT_BLOCKED');

  activity.record({
    userId: user.id,
    type: 'unblock',
    relatedUserId: targetId,
    description: 'Unblocked a user',
  });

  return { unblocked: true };
}

async function listBlocked(user, { skip, take }) {
  const where = { blockerId: user.id };
  const [rows, total] = await Promise.all([
    prisma.block.findMany({
      where,
      include: {
        blocked: {
          include: { profile: true, privacySettings: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.block.count({ where }),
  ]);
  return { rows: rows.map((r) => r.blocked), total };
}

/**
 * Files a report.
 *
 * `alsoBlock` exists because reporting someone and then having to find Block
 * separately is the gap between the two actions — the client offers them
 * together and the API accepts them together.
 *
 * Re-reporting the same person is allowed: a second incident is a second
 * report, and deduplicating them would hide a pattern from whoever reviews.
 */
async function report(user, { userId: targetId, reason, details, alsoBlock = false }) {
  if (user.id === targetId) throw errors.badRequest('You cannot report yourself');
  await relationship.loadCounterpart(targetId);

  const created = await prisma.report.create({
    data: { reporterId: user.id, reportedId: targetId, reason, details: details ?? null },
  });

  let blocked = false;
  if (alsoBlock) {
    const already = await prisma.block.findUnique({
      where: { blockerId_blockedId: { blockerId: user.id, blockedId: targetId } },
    });
    if (!already) await block(user, targetId);
    blocked = true;
  }

  activity.record({
    userId: user.id,
    type: 'report',
    relatedUserId: targetId,
    relatedEntityId: created.id,
    description: `Reported a user for ${reason}`,
    metadata: { reason, also_blocked: blocked },
    status: 'open',
  });

  emitToAdmin('admin:report_filed', {
    report_id: created.id,
    reporter_id: user.id,
    reported_id: targetId,
    reason,
    at: created.createdAt.toISOString(),
  });

  return { report: created, blocked };
}

module.exports = { block, unblock, listBlocked, report };
