'use strict';

const prisma = require('../config/prisma');
const { errors } = require('../utils/errors');
const { emitToUser } = require('../sockets/bus');
const connections = require('../sockets/connections');
const {
  isSameSide,
  showsAllUsers,
  canSee,
  canPair,
  visibleSideWhere,
  pairableWhere,
} = require('../utils/pairing');

/**
 * "May A do this to B?" — asked in exactly one place.
 *
 * Messaging and calling each have their own rules, but they share most of
 * them: blocking, account status, and the other person's privacy settings.
 * Answering those questions per feature is how a check ends up enforced on
 * three paths and forgotten on the fourth — which is precisely what happened
 * in the client, where the chat header could start a call with none of the
 * checks the feed applied.
 *
 * Everything here is server-side and unconditional. The client hides what it
 * can, but hiding is presentation; this is enforcement.
 */

/** Conversation rows store the smaller id first, so lookups are deterministic. */
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

// Pairing — who this app connects at all — is `utils/pairing`: pure rules,
// shared with the serializer (which tells the client, per person, whether
// Chat and Call apply). Every guard below enforces it through [canPair].

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

  return assertLive(other);
}

/** The account checks [loadCounterpart] applies, on a row already loaded. */
function assertLive(other) {
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
 * Can `user` open a brand-new conversation with `otherId`?
 *
 * Beyond the shared checks: both sides must have messaging on, and the pair
 * must be one Earn Money account and one Make Friends account — the same
 * shape `assertCanCall` requires, and for the same reason. Two earners, or
 * two Make Friends accounts, are not a pairing this app connects.
 *
 * **Either side may open it.** This used to be one-directional: the earner
 * was allowed to receive a chat and never to start one. Nothing downstream
 * needed that — `assertCanMessage`, which runs on every single send, has
 * never cared who opened the thread, and a conversation is one row for the
 * pair rather than one per direction, so an earner writing first produces
 * exactly the thread the other order would have. All the restriction
 * achieved was a Chat button missing from half the profiles in the app: an
 * earner looking at someone she had just spoken to could call him back but
 * could not write to him, with nothing on screen to say why.
 */
async function assertCanStartConversation(user, otherId) {
  const other = await assertCanInteract(user.id, otherId);

  if (user.privacySettings && user.privacySettings.allowMessages === false) {
    throw errors.messagingDisabledByMe();
  }
  if (other.privacySettings && other.privacySettings.allowMessages === false) {
    throw errors.messagingDisabledByThem();
  }
  if (!other.profile) throw errors.notFound('That person', 'USER_NOT_FOUND');
  if (!canPair(user, other)) throw errors.chatRoleMismatch();

  return other;
}

/**
 * Can `user` message `otherId`?
 *
 * Just the shared checks, both privacy switches and the pairing rule.
 * Checked on every send, not only when a conversation is opened: either side
 * can switch messaging off — or "Show All Users" off, for a same-side thread
 * — while a thread is on screen, and the next message has to see that. An
 * opposite-side thread is never affected by the latter; see [canPair].
 */
async function assertCanMessage(user, otherId) {
  const other = await assertCanInteract(user.id, otherId);
  return messagingChecks(user, other);
}

/**
 * [assertCanMessage] for a counterpart the caller has **already loaded** —
 * with `profile` and `privacySettings`, as a conversation's own include
 * carries them. The same rules; one database round trip (the block check)
 * instead of two, which is a quarter-second of every send against a distant
 * database.
 */
async function assertCanMessageLoaded(user, other) {
  if (user.id === other?.id) throw errors.badRequest('You cannot do that to yourself');
  assertLive(other);
  if (await isBlockedEitherWay(user.id, other.id)) throw errors.blocked();
  return messagingChecks(user, other);
}

function messagingChecks(user, other) {
  if (user.privacySettings && user.privacySettings.allowMessages === false) {
    throw errors.messagingDisabledByMe();
  }
  if (other.privacySettings && other.privacySettings.allowMessages === false) {
    throw errors.messagingDisabledByThem();
  }
  if (!canPair(user, other)) throw errors.chatRoleMismatch();

  return other;
}

/**
 * Can `user` call `otherId` on `type`?
 *
 * Note what is *not* required: an existing conversation. Calling a stranger
 * is the product — it is what discovery is for and what money pays for.
 *
 * A call pairs whoever [canPair] pairs: an earner with a non-earner always,
 * and two accounts on the same side only when both have "Show All Users" on.
 * Only the first kind is billed — see `call.service.startUnlocked`.
 *
 * Presence is checked here too. Ringing someone the feed just showed as
 * offline contradicts the screen the user is looking at.
 */
async function assertCanCall(user, otherId, type) {
  if (user.id === otherId) throw errors.badRequest('You cannot do that to yourself');

  // Online means a live socket — the app open and connected. The app closes
  // its socket the moment it leaves the foreground (see its lifecycle
  // handling), and the server's ping reaps a socket whose network died, so
  // "connected" here is the truth rather than `profile.presence`, which is a
  // cache. There is no ringing somebody later: calls are real-time only, and a
  // person who cannot hear the ring now is told as much, now. In memory, so
  // it costs nothing and is asked before anything that does.
  if (!connections.isConnected(otherId)) throw errors.calleeOffline();

  // The three things this needs from the database do not depend on each
  // other, so they are asked **at once**, not one after another: against a
  // database hundreds of milliseconds away, every sequential round trip is
  // time the caller spends waiting to find out whether the call can happen.
  //
  // Busy is asked of the Call table, not the `presence` cache, which lags
  // behind a call that has just ended.
  const [other, blocked, liveCall, callerPrivacy] = await Promise.all([
    loadCounterpart(otherId),
    isBlockedEitherWay(user.id, otherId),
    prisma.call.findFirst({
      where: {
        status: { in: ['ringing', 'connected'] },
        OR: [{ callerId: otherId }, { calleeId: otherId }],
      },
      select: { callerId: true, calleeId: true },
    }),
    // The caller's own switches, read now rather than trusted from `user`:
    // a socket-borne call brings the user the socket loaded at handshake,
    // and "Show All Users" may have been turned on since. Asked in this same
    // batch, so it costs no extra round trip.
    prisma.privacySettings.findUnique({ where: { userId: user.id } }),
  ]);
  if (blocked) throw errors.blocked();
  const caller = callerPrivacy ? { ...user, privacySettings: callerPrivacy } : user;

  const privacy = other.privacySettings ?? {};
  const profile = other.profile;
  if (!profile) throw errors.notFound('That person', 'USER_NOT_FOUND');

  if (!canPair(caller, other)) throw errors.callRoleMismatch();

  const accepts = type === 'voice' ? privacy.allowVoiceCalls : privacy.allowVideoCalls;
  const enabled = type === 'voice' ? profile.voiceEnabled : profile.videoEnabled;
  if (accepts === false || !enabled) throw errors.callTypeDisabled(type);

  if (liveCall) {
    // Both pressed Call at once: the first call already rings this side.
    const between = liveCall.callerId === user.id || liveCall.calleeId === user.id;
    throw between ? errors.callCrossed() : errors.calleeBusy();
  }

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

/**
 * Everyone who has blocked `userId` — one direction only.
 *
 * The chat list and a thread's history hide a conversation from the person
 * who was blocked, but not from the one who did the blocking: they keep the
 * chat, see "You blocked …" in it, and can unblock from there. Sending and
 * calling still refuse either way ([isBlockedEitherWay]).
 */
async function blockerIdsOf(userId) {
  const blocks = await prisma.block.findMany({
    where: { blockedId: userId },
    select: { blockerId: true },
  });
  return new Set(blocks.map((b) => b.blockerId));
}

/** True if `otherId` has blocked `userId`. */
async function isBlockedBy(userId, otherId) {
  const block = await prisma.block.findFirst({
    where: { blockerId: otherId, blockedId: userId },
    select: { id: true },
  });
  return Boolean(block);
}

/** Everyone `userId` has an open conversation with. */
async function conversationPeerIdsFor(userId) {
  const rows = await prisma.conversation.findMany({
    where: { OR: [{ userAId: userId }, { userBId: userId }] },
    select: { userAId: true, userBId: true },
  });
  return new Set(rows.map((r) => (r.userAId === userId ? r.userBId : r.userAId)));
}

/** True if the two already have an open conversation. */
async function hasConversation(userId, otherId) {
  const [userAId, userBId] = orderPair(userId, otherId);
  const conversation = await prisma.conversation.findUnique({
    where: { userAId_userBId: { userAId, userBId } },
    select: { id: true },
  });
  return Boolean(conversation);
}

/**
 * Deleted accounts that once held [user]'s phone number — the accounts a
 * fresh sign-up on that number succeeds.
 */
function predecessorsOf(user) {
  return prisma.user.findMany({
    where: {
      status: 'deleted',
      dialCode: user.dialCode,
      // `deleteAccount` tombstones the phone as `deleted_<oldId>_<phone>` —
      // the original number survives as the suffix.
      phone: { endsWith: `_${user.phone}` },
      id: { not: user.id },
    },
    select: { id: true },
  });
}

/** Whether a conversation holds anything a person wrote (notes don't count). */
async function hasWrittenMessages(conversationId) {
  const count = await prisma.message.count({ where: { conversationId, event: null } });
  return count > 0;
}

/**
 * Re-points one thread of deleted account [oldId] at [newUser] — see
 * [relinkConversationsForPhone] for what that means for each side.
 *
 * The thread with the history is always the one kept. Messages cannot be
 * moved between threads: each one's encryption is bound to its thread's id,
 * so a moved message could never be opened again. So when a thread between
 * the peer and the new account already exists — the peer opened a chat with
 * the new account before this ran — and it holds nothing anyone wrote, it is
 * the one removed, and the old thread takes its place. If it does hold
 * written messages, both stay: merging would destroy one side's history.
 *
 * Returns what happened, for the repair script's report.
 */
async function relinkOne(conversation, oldId, newUser, now) {
  const peerWasA = conversation.userAId !== oldId;
  const peerId = peerWasA ? conversation.userAId : conversation.userBId;
  if (peerId === newUser.id) return 'skipped';

  const [userAId, userBId] = orderPair(peerId, newUser.id);
  const newAccountIsA = userAId === newUser.id;

  const existing = await prisma.conversation.findUnique({
    where: { userAId_userBId: { userAId, userBId } },
  });
  if (existing) {
    if (await hasWrittenMessages(existing.id)) return 'kept-both';
    await prisma.$transaction([
      prisma.message.deleteMany({ where: { conversationId: existing.id } }),
      prisma.conversation.delete({ where: { id: existing.id } }),
    ]);
  }

  // The peer's own unread, mute, pin and delete-for-me carry over — they are
  // the peer's. The new account's side starts deleted as of now.
  const peerUnread = peerWasA ? conversation.unreadForA : conversation.unreadForB;
  const peerMuted = peerWasA ? conversation.mutedByA : conversation.mutedByB;
  const peerPinned = peerWasA ? conversation.pinnedByA : conversation.pinnedByB;
  const peerDeletedAt = peerWasA ? conversation.deletedAtByA : conversation.deletedAtByB;

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      userAId,
      userBId,
      unreadForA: newAccountIsA ? 0 : peerUnread,
      unreadForB: newAccountIsA ? peerUnread : 0,
      mutedByA: newAccountIsA ? false : peerMuted,
      mutedByB: newAccountIsA ? peerMuted : false,
      pinnedByA: newAccountIsA ? false : peerPinned,
      pinnedByB: newAccountIsA ? peerPinned : false,
      deletedAtByA: newAccountIsA ? now : peerDeletedAt,
      deletedAtByB: newAccountIsA ? peerDeletedAt : now,
    },
  });

  // Both apps reload their lists: the peer's thread now shows the new
  // account, and a duplicate either of them was showing is gone.
  const payload = { conversation_id: conversation.id, user_id: newUser.id };
  emitToUser(peerId, 'conversation:relinked', payload);
  emitToUser(newUser.id, 'conversation:relinked', payload);
  return existing ? 'replaced-empty-duplicate' : 'relinked';
}

/**
 * Carries a deleted account's conversations over to a fresh account
 * registered on the same phone number — for the *other* person only.
 *
 * `deleteAccount` never lets a new registration reuse the old `User.id`, so
 * the new sign-up is a different account from day one. Two things are true of
 * what it should inherit:
 *
 *  * **The other person keeps talking to the number.** Their thread with the
 *    deleted account is re-pointed at the new one, so its header, profile
 *    and calls show the new account's live name and photo, and a message
 *    they send reaches it. Their history in that thread is untouched, and
 *    they never end up with two chats for the same number.
 *  * **The new account inherits none of it.** Deleting an account ends that
 *    account's side of every chat for good. So the new account's side of
 *    each re-pointed thread is marked deleted-for-me as of now: the thread
 *    stays out of its list, and none of the old messages are ever shown to
 *    it — they were encrypted for the deleted account's keys and are not its
 *    to read. If the other person writes again, the thread appears holding
 *    only what is new, exactly as after deleting a chat.
 *
 * Called at `/onboarding/complete` — a bare OTP verification has no name or
 * photo yet — and by the repair script for sign-ups that happened while this
 * was not running. Safe to call again: a number nobody deleted before, or a
 * thread already carried over, finds nothing to do.
 */
async function relinkConversationsForPhone(user, { now = new Date() } = {}) {
  const outcomes = [];
  for (const old of await predecessorsOf(user)) {
    const conversations = await prisma.conversation.findMany({
      where: { OR: [{ userAId: old.id }, { userBId: old.id }] },
    });
    for (const conversation of conversations) {
      outcomes.push(await relinkOne(conversation, old.id, user, now));
    }
  }
  return outcomes;
}

/**
 * Before a new chat is opened between [userId] and [otherId]: if either is a
 * re-registration of a deleted account that already had a chat with the
 * other, that chat is carried over and reused instead of a second one being
 * started. Without this, opening a chat with someone who had deleted and
 * re-created their account put a second, empty chat for the same number
 * beside the old one.
 */
async function relinkBetween(userId, otherId) {
  const users = await prisma.user.findMany({
    where: { id: { in: [userId, otherId] } },
    select: { id: true, dialCode: true, phone: true },
  });
  const now = new Date();
  for (const user of users) {
    const peerId = user.id === userId ? otherId : userId;
    for (const old of await predecessorsOf(user)) {
      const [userAId, userBId] = orderPair(old.id, peerId);
      const conversation = await prisma.conversation.findUnique({
        where: { userAId_userBId: { userAId, userBId } },
      });
      if (conversation) await relinkOne(conversation, old.id, user, now);
    }
  }
}

/**
 * Carries over, for [userId], any chat still on a deleted account whose phone
 * number has since been registered again — the self-healing path.
 *
 * The carry-over normally happens when the new account finishes sign-up
 * ([relinkConversationsForPhone]). A sign-up that happened while that was not
 * running, or failed part-way, left the other person's chat on the deleted
 * account for good: "has turned off messages and calls", "This profile is no
 * longer available", with the same number alive again on a new account. This
 * runs whenever that person loads their chats or opens one, so the chat
 * finds the new account by itself — no script for anyone to remember.
 *
 * Cheap when there is nothing to do: one query for this person's chats with
 * a deleted account, which is almost always none. Only a *finished* sign-up
 * counts — a half-done one has no name or photo to show yet.
 *
 * [conversationId] narrows it to the one chat being opened. Returns how many
 * chats were carried over.
 */
async function relinkDeletedPeersOf(userId, { conversationId } = {}) {
  const peer = { select: { id: true, dialCode: true, phone: true } };
  const threads = await prisma.conversation.findMany({
    where: {
      ...(conversationId ? { id: conversationId } : {}),
      OR: [
        { userAId: userId, userB: { status: 'deleted' } },
        { userBId: userId, userA: { status: 'deleted' } },
      ],
    },
    include: { userA: peer, userB: peer },
  });
  if (threads.length === 0) return 0;

  const now = new Date();
  let moved = 0;
  for (const conversation of threads) {
    const old = conversation.userAId === userId ? conversation.userB : conversation.userA;
    // `deleteAccount` tombstones the number as `deleted_<id>_<number>`.
    const prefix = `deleted_${old.id}_`;
    if (!old.phone.startsWith(prefix)) continue;
    const successor = await prisma.user.findFirst({
      where: {
        dialCode: old.dialCode,
        phone: old.phone.slice(prefix.length),
        status: { not: 'deleted' },
        deletedAt: null,
        profile: { onboardingStatus: 'ONBOARDING_COMPLETED' },
      },
      select: { id: true, dialCode: true, phone: true },
    });
    if (!successor) continue;
    const outcome = await relinkOne(conversation, old.id, successor, now);
    if (outcome === 'relinked' || outcome === 'replaced-empty-duplicate') moved++;
  }
  return moved;
}

module.exports = {
  relinkConversationsForPhone,
  relinkBetween,
  relinkDeletedPeersOf,
  isSameSide,
  showsAllUsers,
  canSee,
  canPair,
  visibleSideWhere,
  pairableWhere,
  orderPair,
  isBlockedEitherWay,
  loadCounterpart,
  assertCanInteract,
  assertCanStartConversation,
  assertCanMessage,
  assertCanMessageLoaded,
  assertCanCall,
  blockedIdsFor,
  blockerIdsOf,
  isBlockedBy,
  conversationPeerIdsFor,
  hasConversation,
};
