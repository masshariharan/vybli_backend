'use strict';

const prisma = require('../config/prisma');
const { errors } = require('../utils/errors');

/**
 * "May A do this to B?" — asked in exactly one place.
 *
 * Messaging, calling and friend requests each have their own rules, but they
 * share most of them: blocking, account status, and the other person's privacy
 * settings. Answering those questions per feature is how a check ends up
 * enforced on three paths and forgotten on the fourth — which is precisely
 * what happened in the client, where the chat header could start a call with
 * none of the checks the feed applied.
 *
 * Everything here is server-side and unconditional. The client hides what it
 * can, but hiding is presentation; this is enforcement.
 */

/** Friendship rows store the smaller id first, so lookups are deterministic. */
function orderPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

/** True if either has blocked the other — blocking is symmetric in effect. */
async function isBlockedEitherWay(userId, otherId) {
  const block = await prisma.block.findFirst({
    where: {
      OR: [
        { blockerId: userId, blockedId: otherId },
        { blockerId: otherId, blockedId: userId },
      ],
    },
    select: { id: true },
  });
  return Boolean(block);
}

async function areFriends(userId, otherId) {
  const [userAId, userBId] = orderPair(userId, otherId);
  const friendship = await prisma.friendship.findUnique({
    where: { userAId_userBId: { userAId, userBId } },
    select: { id: true },
  });
  return Boolean(friendship);
}

/**
 * Loads the other party with the bits every guard needs.
 *
 * Throws rather than returning null: every caller treats a missing or deleted
 * account the same way, and making each one remember to check is how a null
 * reaches a serializer.
 */
async function loadCounterpart(otherId) {
  const other = await prisma.user.findUnique({
    where: { id: otherId },
    include: {
      profile: true,
      privacySettings: true,
    },
  });

  if (!other || other.status === 'deleted' || other.deletedAt) {
    throw errors.notFound('That person', 'USER_NOT_FOUND');
  }
  if (other.status === 'suspended') {
    // Deliberately the same message a block produces. Telling one user that
    // another has been suspended is not their business.
    throw errors.notFound('That person', 'USER_NOT_FOUND');
  }
  return other;
}

/**
 * The checks shared by every interaction: not yourself, not blocked, real
 * account. Returns the loaded counterpart so callers need no second read.
 */
async function assertCanInteract(userId, otherId) {
  if (userId === otherId) throw errors.badRequest('You cannot do that to yourself');
  const other = await loadCounterpart(otherId);
  if (await isBlockedEitherWay(userId, otherId)) throw errors.blocked();
  return other;
}

/**
 * Can `user` send a friend request to `otherId`?
 *
 * Beyond the shared checks: both sides must have messaging on, because a
 * friend request exists only to unlock messaging and unlocking nothing is not
 * a thing to ask for. The recipient must be an Earn Money profile and the
 * sender must not be one — the app's rule, and the reason an earner account
 * has no received-requests list of its own.
 */
async function assertCanSendFriendRequest(user, otherId) {
  const other = await assertCanInteract(user.id, otherId);

  if (user.privacySettings && user.privacySettings.allowMessages === false) {
    throw errors.messagingDisabledByMe();
  }
  if (other.privacySettings && other.privacySettings.allowMessages === false) {
    throw errors.messagingDisabledByThem();
  }
  if (user.profile?.isEarner) throw errors.senderIsEarner();
  if (!other.profile?.isEarner) throw errors.notAnEarner();

  return other;
}

/**
 * Can `user` message `otherId`?
 *
 * Friendship first, then both privacy switches. Checked on every send, not
 * only when a conversation is opened: either side can switch messaging off
 * while a thread is on screen, and the next message has to see that.
 */
async function assertCanMessage(user, otherId) {
  const other = await assertCanInteract(user.id, otherId);

  if (user.privacySettings && user.privacySettings.allowMessages === false) {
    throw errors.messagingDisabledByMe();
  }
  if (other.privacySettings && other.privacySettings.allowMessages === false) {
    throw errors.messagingDisabledByThem();
  }
  if (!(await areFriends(user.id, otherId))) throw errors.notFriends();

  return other;
}

/**
 * Can `user` call `otherId` on `type`?
 *
 * Note what is *not* required: friendship. Calling a stranger is the product —
 * it is what discovery is for and what money pays for. Messaging one is what
 * the friend gate exists to prevent.
 *
 * A call must pair an earner with a non-earner: that is the only shape the
 * billing side understands (one party earns, the other spends money), and it
 * is what keeps two Earn Money accounts — or two Make Friends accounts — from
 * ever ringing each other.
 *
 * Presence is checked here too. Ringing someone the feed just showed as
 * offline contradicts the screen the user is looking at.
 */
async function assertCanCall(user, otherId, type) {
  const other = await assertCanInteract(user.id, otherId);
  const privacy = other.privacySettings ?? {};
  const profile = other.profile;

  if (!profile) throw errors.notFound('That person', 'USER_NOT_FOUND');

  if (Boolean(user.profile?.isEarner) === Boolean(profile.isEarner)) {
    throw errors.callRoleMismatch();
  }

  const accepts = type === 'voice' ? privacy.allowVoiceCalls : privacy.allowVideoCalls;
  const enabled = type === 'voice' ? profile.voiceEnabled : profile.videoEnabled;
  if (accepts === false || !enabled) throw errors.callTypeDisabled(type);

  // Busy is asked of the Call table, not the `presence` cache. That cache is
  // set to `busy` the instant a call starts ringing and only cleared once the
  // call's background bookkeeping gets around to it — a client that redials a
  // moment after a call ended, or one whose peer's bookkeeping is merely
  // running slow, would otherwise be told "busy" about someone who is not.
  // The call table is written and read in the same request that decides this,
  // so there is nothing here for it to lag behind.
  const liveCall = await prisma.call.findFirst({
    where: {
      status: { in: ['ringing', 'connected'] },
      OR: [{ callerId: otherId }, { calleeId: otherId }],
    },
    select: { id: true },
  });
  if (liveCall) throw errors.calleeBusy();

  if (profile.presence !== 'online') throw errors.calleeOffline();

  return other;
}

/**
 * Ids `userId` must never be shown: everyone either side of a block.
 *
 * Returned as a Set so a feed query can exclude them in one pass instead of a
 * round trip per candidate.
 */
async function blockedIdsFor(userId) {
  const blocks = await prisma.block.findMany({
    where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
    select: { blockerId: true, blockedId: true },
  });
  const ids = new Set();
  for (const b of blocks) {
    ids.add(b.blockerId === userId ? b.blockedId : b.blockerId);
  }
  return ids;
}

/** Everyone `userId` is friends with. */
async function friendIdsFor(userId) {
  const rows = await prisma.friendship.findMany({
    where: { OR: [{ userAId: userId }, { userBId: userId }] },
    select: { userAId: true, userBId: true },
  });
  return new Set(rows.map((r) => (r.userAId === userId ? r.userBId : r.userAId)));
}

/**
 * Where `userId` stands with `otherId`, in the four states the profile button
 * renders: none / requestSent / requestReceived / friends.
 *
 * Blocking collapses to `none` — a FRIEND badge and a live Message button on
 * someone you just blocked is a contradiction.
 */
async function connectionStatus(userId, otherId) {
  if (userId === otherId) return 'none';
  if (await isBlockedEitherWay(userId, otherId)) return 'none';
  if (await areFriends(userId, otherId)) return 'friends';

  const request = await prisma.friendRequest.findFirst({
    where: {
      status: 'pending',
      OR: [
        { requesterId: userId, addresseeId: otherId },
        { requesterId: otherId, addresseeId: userId },
      ],
    },
    select: { requesterId: true },
  });

  if (!request) return 'none';
  return request.requesterId === userId ? 'requestSent' : 'requestReceived';
}

module.exports = {
  orderPair,
  isBlockedEitherWay,
  areFriends,
  loadCounterpart,
  assertCanInteract,
  assertCanSendFriendRequest,
  assertCanMessage,
  assertCanCall,
  blockedIdsFor,
  friendIdsFor,
  connectionStatus,
};
