'use strict';

const prisma = require('../config/prisma');
const { errors } = require('../utils/errors');
const relationship = require('./relationship.service');
const activity = require('./activity.service');
const notificationService = require('./notification.service');
const { emitToUser, emitToAdmin } = require('../sockets/bus');
const serialize = require('../utils/serialize');

/**
 * Friend requests — the gate that unlocks messaging.
 *
 * A request exists for exactly one reason: to let two people message. That is
 * why messaging being switched off on either side blocks one, and why
 * accepting creates the conversation in the same transaction. A friendship
 * without a conversation, or a conversation without a friendship, would each
 * be a state the app has no screen for.
 */

const USER_INCLUDE = {
  profile: { include: { city: true } },
  privacySettings: true,
};

const REQUEST_INCLUDE = {
  requester: { include: USER_INCLUDE },
  addressee: { include: USER_INCLUDE },
};

/**
 * Sends a request.
 *
 * Re-sending after a rejection or a cancellation reuses the same row rather
 * than stacking a second one — the unique constraint on the pair is what makes
 * that the only option, and it is also the right behaviour.
 */
async function send(user, { userId: targetId, message }) {
  await relationship.assertCanSendFriendRequest(user, targetId);

  if (await relationship.areFriends(user.id, targetId)) throw errors.alreadyFriends();

  // A request from them to me is an accept waiting to happen, not a new
  // request — telling the user "already exists" when the answer is on their
  // own screen would be obtuse.
  const inbound = await prisma.friendRequest.findUnique({
    where: { requesterId_addresseeId: { requesterId: targetId, addresseeId: user.id } },
  });
  if (inbound?.status === 'pending') {
    return accept(user, inbound.id, { viaReciprocal: true });
  }

  const existing = await prisma.friendRequest.findUnique({
    where: { requesterId_addresseeId: { requesterId: user.id, addresseeId: targetId } },
  });
  if (existing?.status === 'pending') throw errors.requestExists();

  const data = {
    status: 'pending',
    message: message ?? null,
    respondedAt: null,
  };

  const request = existing
    ? await prisma.friendRequest.update({
        where: { id: existing.id },
        data,
        include: REQUEST_INCLUDE,
      })
    : await prisma.friendRequest.create({
        data: { requesterId: user.id, addresseeId: targetId, ...data },
        include: REQUEST_INCLUDE,
      });

  await notificationService.notify({
    userId: targetId,
    kind: 'friendRequest',
    title: `${user.profile?.name ?? 'Someone'} wants to connect`,
    body: message ?? 'Tap to see their profile.',
    data: { request_id: request.id, user_id: user.id },
  });

  emitToUser(targetId, 'friend:request', serialize.friendRequest(request, targetId));

  // Both halves: it is "sent to X" on one timeline and "received from Y" on
  // the other, and recording only the sender leaves the recipient's history
  // with a hole exactly where somebody did something to them.
  activity.recordPair(
    {
      userId: user.id,
      type: 'friend_request',
      relatedUserId: targetId,
      relatedEntityId: request.id,
      description: `Sent a friend request to ${activity.nameOf(request.addressee)}`,
      status: 'pending',
      metadata: { direction: 'sent' },
    },
    {
      userId: targetId,
      type: 'friend_request',
      relatedUserId: user.id,
      relatedEntityId: request.id,
      description: `Received a friend request from ${activity.nameOf(user)}`,
      status: 'pending',
      metadata: { direction: 'received' },
    }
  );

  emitToAdmin('admin:friend_request', {
    request_id: request.id,
    requester: { id: user.id, name: user.profile?.name ?? null },
    addressee: { id: targetId, name: request.addressee?.profile?.name ?? null },
    at: new Date().toISOString(),
  });

  return { request, created: !existing };
}

/**
 * Accepts a request.
 *
 * Friendship and conversation are created together with the status change. If
 * any of the three failed independently the pair would end up able to message
 * with no thread, or friends with no way to talk.
 */
async function accept(user, requestId, { viaReciprocal = false } = {}) {
  const request = await prisma.friendRequest.findUnique({
    where: { id: requestId },
    include: REQUEST_INCLUDE,
  });

  if (!request) throw errors.notFound('Friend request', 'FRIEND_REQUEST_NOT_FOUND');
  // Only the addressee may accept. The requester "accepting" their own request
  // would be a self-approval.
  if (request.addresseeId !== user.id) {
    throw errors.forbidden('That request is not yours to accept.', 'NOT_REQUEST_ADDRESSEE');
  }
  if (request.status === 'accepted') {
    return { request, alreadyAccepted: true };
  }
  if (request.status !== 'pending') {
    throw errors.conflict('That request is no longer pending.', 'REQUEST_NOT_PENDING');
  }

  if (await relationship.isBlockedEitherWay(user.id, request.requesterId)) {
    throw errors.blocked();
  }

  const [userAId, userBId] = relationship.orderPair(user.id, request.requesterId);
  const now = new Date();

  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.friendRequest.update({
      where: { id: requestId },
      data: { status: 'accepted', respondedAt: now },
      include: REQUEST_INCLUDE,
    });

    await tx.friendship.upsert({
      where: { userAId_userBId: { userAId, userBId } },
      create: { userAId, userBId },
      update: {},
    });

    const conversation = await tx.conversation.upsert({
      where: { userAId_userBId: { userAId, userBId } },
      create: { userAId, userBId, lastMessageAt: now },
      update: {},
    });

    // The opening message from the request becomes the first message in the
    // thread — it is what they said, and losing it would open the chat on an
    // empty screen after a conversation had already started.
    if (updated.message) {
      const existing = await tx.message.count({
        where: { conversationId: conversation.id },
      });
      if (existing === 0) {
        await tx.message.create({
          data: {
            conversationId: conversation.id,
            senderId: updated.requesterId,
            text: updated.message,
            status: 'delivered',
            createdAt: updated.createdAt,
          },
        });
      }
    }

    return { request: updated, conversation };
  });

  await notificationService.notify({
    userId: request.requesterId,
    kind: 'friendRequestAccepted',
    title: `${user.profile?.name ?? 'They'} accepted your request`,
    body: 'You can message each other now.',
    data: {
      conversation_id: result.conversation.id,
      user_id: user.id,
      request_id: request.id,
    },
  });

  emitToUser(request.requesterId, 'friend:accepted', {
    request_id: request.id,
    conversation_id: result.conversation.id,
    user: serialize.userSummary(result.request.addressee),
  });

  // Three facts, not one: the request was answered, and a friendship now
  // exists between two accounts. The timeline shows the answer; the
  // friendship row is what unlocked messaging.
  activity.recordPair(
    {
      userId: user.id,
      type: 'friend_request_accepted',
      relatedUserId: request.requesterId,
      relatedEntityId: request.id,
      description: `Accepted a friend request from ${activity.nameOf(result.request.requester)}`,
      status: 'accepted',
      metadata: { conversation_id: result.conversation.id, via_reciprocal: viaReciprocal },
    },
    {
      userId: request.requesterId,
      type: 'friend_request_accepted',
      relatedUserId: user.id,
      relatedEntityId: request.id,
      description: `${activity.nameOf(result.request.addressee)} accepted the friend request`,
      status: 'accepted',
      metadata: { conversation_id: result.conversation.id },
    }
  );
  activity.recordPair(
    {
      userId: user.id,
      type: 'friendship_created',
      relatedUserId: request.requesterId,
      relatedEntityId: result.conversation.id,
      description: `Became friends with ${activity.nameOf(result.request.requester)}`,
      status: 'active',
    },
    {
      userId: request.requesterId,
      type: 'friendship_created',
      relatedUserId: user.id,
      relatedEntityId: result.conversation.id,
      description: `Became friends with ${activity.nameOf(result.request.addressee)}`,
      status: 'active',
    }
  );

  return { ...result, viaReciprocal };
}

/** Declines. The other side is not told — that is what the app promises. */
async function reject(user, requestId) {
  const request = await prisma.friendRequest.findUnique({ where: { id: requestId } });
  if (!request) throw errors.notFound('Friend request', 'FRIEND_REQUEST_NOT_FOUND');
  if (request.addresseeId !== user.id) {
    throw errors.forbidden('That request is not yours to decline.', 'NOT_REQUEST_ADDRESSEE');
  }
  if (request.status !== 'pending') {
    throw errors.conflict('That request is no longer pending.', 'REQUEST_NOT_PENDING');
  }

  const rejected = await prisma.friendRequest.update({
    where: { id: requestId },
    data: { status: 'rejected', respondedAt: new Date() },
    include: REQUEST_INCLUDE,
  });

  activity.recordPair(
    {
      userId: user.id,
      type: 'friend_request_rejected',
      relatedUserId: request.requesterId,
      relatedEntityId: requestId,
      description: `Declined a friend request from ${activity.nameOf(rejected.requester)}`,
      status: 'rejected',
    },
    {
      userId: request.requesterId,
      type: 'friend_request_rejected',
      relatedUserId: user.id,
      relatedEntityId: requestId,
      description: `Friend request to ${activity.nameOf(rejected.addressee)} was declined`,
      status: 'rejected',
    }
  );

  return rejected;
}

/**
 * Withdraws a request you sent.
 *
 * Only while it is still pending. Once accepted it is a friendship, and ending
 * that is unfriending — a different action with different consequences.
 */
async function cancel(user, requestId) {
  const request = await prisma.friendRequest.findUnique({ where: { id: requestId } });
  if (!request) throw errors.notFound('Friend request', 'FRIEND_REQUEST_NOT_FOUND');
  if (request.requesterId !== user.id) {
    throw errors.forbidden('That request is not yours to cancel.', 'NOT_REQUEST_REQUESTER');
  }
  if (request.status !== 'pending') {
    throw errors.conflict('That request is no longer pending.', 'REQUEST_NOT_PENDING');
  }

  const updated = await prisma.friendRequest.update({
    where: { id: requestId },
    data: { status: 'cancelled', respondedAt: new Date() },
    include: REQUEST_INCLUDE,
  });

  activity.recordPair(
    {
      userId: user.id,
      type: 'friend_request_cancelled',
      relatedUserId: request.addresseeId,
      relatedEntityId: requestId,
      description: `Withdrew a friend request to ${activity.nameOf(updated.addressee)}`,
      status: 'cancelled',
    },
    {
      userId: request.addresseeId,
      type: 'friend_request_cancelled',
      relatedUserId: user.id,
      relatedEntityId: requestId,
      description: `${activity.nameOf(updated.requester)} withdrew their friend request`,
      status: 'cancelled',
    }
  );

  emitToUser(request.addresseeId, 'friend:cancelled', { request_id: requestId });
  return updated;
}

/**
 * Ends a friendship.
 *
 * The conversation is deleted with it. Leaving a thread that can no longer be
 * replied to is the dead-end state the request gate exists to avoid, and
 * cascading removes the messages too.
 */
async function unfriend(user, otherId) {
  const [userAId, userBId] = relationship.orderPair(user.id, otherId);

  const friendship = await prisma.friendship.findUnique({
    where: { userAId_userBId: { userAId, userBId } },
  });
  if (!friendship) throw errors.notFound('Friendship', 'NOT_FRIENDS');

  await prisma.$transaction([
    prisma.friendship.delete({ where: { id: friendship.id } }),
    prisma.conversation.deleteMany({ where: { userAId, userBId } }),
    prisma.friendRequest.deleteMany({
      where: {
        OR: [
          { requesterId: user.id, addresseeId: otherId },
          { requesterId: otherId, addresseeId: user.id },
        ],
      },
    }),
  ]);

  emitToUser(otherId, 'friend:removed', { user_id: user.id });
  return { removed: true };
}

async function listRequests(user, { direction, status, skip, take }) {
  const where = {};

  if (direction === 'incoming') where.addresseeId = user.id;
  else if (direction === 'outgoing') where.requesterId = user.id;
  else where.OR = [{ addresseeId: user.id }, { requesterId: user.id }];

  where.status = status ?? 'pending';

  // Blocked people vanish from the list rather than lingering as rows you
  // cannot act on.
  const blockedIds = await relationship.blockedIdsFor(user.id);
  if (blockedIds.size > 0) {
    where.requesterId = where.requesterId
      ? where.requesterId
      : { notIn: [...blockedIds] };
    where.addresseeId = where.addresseeId
      ? where.addresseeId
      : { notIn: [...blockedIds] };
  }

  const [rows, total] = await Promise.all([
    prisma.friendRequest.findMany({
      where,
      include: REQUEST_INCLUDE,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.friendRequest.count({ where }),
  ]);

  return { rows, total };
}

async function listFriends(user, { skip, take }) {
  const blockedIds = await relationship.blockedIdsFor(user.id);

  const where = {
    OR: [{ userAId: user.id }, { userBId: user.id }],
    NOT:
      blockedIds.size > 0
        ? [{ userAId: { in: [...blockedIds] } }, { userBId: { in: [...blockedIds] } }]
        : undefined,
  };

  const [rows, total] = await Promise.all([
    prisma.friendship.findMany({
      where,
      include: {
        userA: { include: USER_INCLUDE },
        userB: { include: USER_INCLUDE },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.friendship.count({ where }),
  ]);

  const friends = rows.map((row) => (row.userAId === user.id ? row.userB : row.userA));
  return { rows: friends, total };
}

/** Badge count for the Requests tab. Zero for anyone who cannot receive one. */
async function pendingIncomingCount(user) {
  if (!user.profile?.isEarner) return 0;
  const blockedIds = await relationship.blockedIdsFor(user.id);
  return prisma.friendRequest.count({
    where: {
      addresseeId: user.id,
      status: 'pending',
      requesterId: blockedIds.size > 0 ? { notIn: [...blockedIds] } : undefined,
    },
  });
}

module.exports = {
  send,
  accept,
  reject,
  cancel,
  unfriend,
  listRequests,
  listFriends,
  pendingIncomingCount,
  REQUEST_INCLUDE,
};
