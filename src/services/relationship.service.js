'use strict';

const prisma = require('../config/prisma');
const { errors } = require('../utils/errors');
const { emitToUser } = require('../sockets/bus');

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
 * Can `user` open a brand-new conversation with `otherId`?
 *
 * Beyond the shared checks: both sides must have messaging on, and the
 * recipient must be an Earn Money profile while the sender must not be one —
 * the app's rule, and the reason an earner account never initiates a chat of
 * its own, only receives one.
 */
async function assertCanStartConversation(user, otherId) {
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
 * Just the shared checks plus both privacy switches. Checked on every send,
 * not only when a conversation is opened: either side can switch messaging
 * off while a thread is on screen, and the next message has to see that.
 */
async function assertCanMessage(user, otherId) {
  const other = await assertCanInteract(user.id, otherId);

  if (user.privacySettings && user.privacySettings.allowMessages === false) {
    throw errors.messagingDisabledByMe();
  }
  if (other.privacySettings && other.privacySettings.allowMessages === false) {
    throw errors.messagingDisabledByThem();
  }

  return other;
}

/**
 * Can `user` call `otherId` on `type`?
 *
 * Note what is *not* required: an existing conversation. Calling a stranger
 * is the product — it is what discovery is for and what money pays for.
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
 * Reconnects existing conversations once a freshly onboarded account lands
 * on a phone number a deleted account once held.
 *
 * `deleteAccount` deliberately never lets a new registration reuse the old
 * `User.id` — see the note there — so a second signup on the same number is,
 * correctly, a different account with a different id from day one. Left at
 * that, though, every conversation the old account was ever part of becomes
 * permanently unreachable: `Conversation` rows are keyed on that old id and
 * nothing ever re-points them on its own — the person on the other end
 * would need to re-discover this "stranger" and start a brand new chat, with
 * no sign anywhere that it is the same phone number as before. That is not what
 * this app promises: item 2 of the requirements this satisfies says an
 * existing conversation must be *updated*, not abandoned in favour of a
 * fresh one.
 *
 * So the id stays new, but the *thread* does not: every `Conversation` the
 * phone number's previous owner(s) left behind is re-pointed at the new
 * account. Nothing about the messages already in those threads changes —
 * they keep whatever the deleted account's row still says about who sent
 * them (see `deleteAccount`'s own note on why that row is never renamed) —
 * only which *live* account the thread now continues with.
 *
 * Called once, at `/onboarding/complete`, rather than at the moment the
 * account is first created: a bare OTP verification has no name or photo
 * yet, and re-pointing somebody's existing chat at an account that might
 * never finish signing up would trade a real name for a blank one. Safe to
 * call unconditionally — a phone number nobody deleted before, or a second
 * completion of the same onboarding, both find nothing to do.
 */
async function relinkConversationsForPhone(user) {
  const previousOwners = await prisma.user.findMany({
    where: {
      status: 'deleted',
      dialCode: user.dialCode,
      // `deleteAccount` tombstones the phone as `deleted_<oldId>_<phone>` —
      // the original number survives as the suffix, which is what a fresh
      // signup's own (unprefixed) number is matched against here.
      phone: { endsWith: `_${user.phone}` },
      id: { not: user.id },
    },
    select: { id: true },
  });
  if (previousOwners.length === 0) return;

  for (const old of previousOwners) {
    const conversations = await prisma.conversation.findMany({
      where: { OR: [{ userAId: old.id }, { userBId: old.id }] },
    });

    for (const conversation of conversations) {
      const peerWasA = conversation.userAId !== old.id;
      const peerId = peerWasA ? conversation.userAId : conversation.userBId;
      // Guards a pathological row (a conversation with itself); never
      // actually reachable through the ordinary API.
      if (peerId === user.id) continue;

      const [userAId, userBId] = orderPair(peerId, user.id);
      const newAccountIsA = userAId === user.id;

      // A conversation for this exact pair may already exist — the new
      // account already reached this same peer directly before this ran, or a
      // second deleted account under the same number also talked to them. Two
      // rows can never share one `[userAId, userBId]` pair, so the older
      // thread is left exactly where it is, as history, rather than risk
      // either side's messages to resolve a collision automatically.
      const existing = await prisma.conversation.findUnique({
        where: { userAId_userBId: { userAId, userBId } },
      });
      if (existing) continue;

      // The peer's own unread count, mute and pin preferences are theirs
      // regardless of who the thread continues with, so they carry over. The
      // new account's side starts clean — the old account's leftover unread
      // count, mute flag and pin flag described a person who is not this one.
      const peerUnread = peerWasA ? conversation.unreadForA : conversation.unreadForB;
      const peerMuted = peerWasA ? conversation.mutedByA : conversation.mutedByB;
      const peerPinned = peerWasA ? conversation.pinnedByA : conversation.pinnedByB;

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
        },
      });

      // Told the moment it happens, not left for the peer's next unrelated
      // refresh to notice — the same immediacy `presence:changed` gives an
      // ordinary status change.
      emitToUser(peerId, 'conversation:relinked', {
        conversation_id: conversation.id,
        user_id: user.id,
      });
    }
  }
}

module.exports = {
  orderPair,
  isBlockedEitherWay,
  loadCounterpart,
  assertCanInteract,
  assertCanStartConversation,
  assertCanMessage,
  assertCanCall,
  blockedIdsFor,
  conversationPeerIdsFor,
  hasConversation,
  relinkConversationsForPhone,
};
