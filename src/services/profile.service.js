'use strict';

const prisma = require('../config/prisma');
const { errors } = require('../utils/errors');
const avatarCatalog = require('../config/avatarCatalog');
const activity = require('./activity.service');
const { USER_INCLUDE } = require('./auth.service');
const relationship = require('./relationship.service');
const { emitToUsers, emitToPresenceWatchers, emitToAdmin } = require('../sockets/bus');

/**
 * Profiles, mine and other people's.
 *
 * The two are deliberately different reads. Mine returns everything including
 * my phone number and where I am in onboarding; someone else's is filtered by
 * their privacy settings and carries the relationship context the profile
 * screen needs to pick its primary button.
 */

async function getMyProfile(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: USER_INCLUDE,
  });
  if (!user) throw errors.notFound('Profile', 'PROFILE_NOT_FOUND');
  return user;
}

/**
 * Someone else's profile.
 *
 * Hidden profiles stay reachable by direct link for people who already have a
 * conversation open with them: hiding removes you from *discovery*, and
 * opening the chat header should not hit a wall. A stranger who guessed the
 * id gets a not-found, which is also the honest answer to "is this person on
 * Vybli".
 */
async function getPublicProfile(viewer, targetId) {
  const target = await relationship.loadCounterpart(targetId);

  if (await relationship.isBlockedEitherWay(viewer.id, targetId)) {
    throw errors.notFound('That person', 'USER_NOT_FOUND');
  }

  const hidden = target.privacySettings?.profileVisibleToEveryone === false;
  if (hidden && viewer.id !== targetId) {
    const known = await relationship.hasConversation(viewer.id, targetId);
    if (!known) throw errors.notFound('That person', 'USER_NOT_FOUND');
  }

  const languages = await prisma.userLanguage.findMany({ where: { userId: targetId } });

  return { user: { ...target, languages } };
}

/**
 * Edits the signed-in user's profile.
 *
 * Languages are replaced wholesale when supplied — the client sends the full
 * chosen set, and diffing a list of six strings server-side would be inventing
 * work.
 */
async function updateProfile(user, payload) {
  const data = {};
  if (payload.name !== undefined) data.name = payload.name;
  if (payload.age !== undefined) data.age = payload.age;
  // No `gender` — see the doc comment on the `profile.update` schema in
  // `validators/schemas.js` for why it is fixed once set at onboarding.
  if (payload.bio !== undefined) data.bio = payload.bio;

  // Stored as sent, for the same reason as the languages below: the catalogue
  // is the client's, so there is nothing here to validate an id against.
  if (payload.city_id !== undefined) data.cityId = payload.city_id;

  const operations = [];
  if (Object.keys(data).length > 0) {
    operations.push(prisma.userProfile.update({ where: { userId: user.id }, data }));
  }

  // Stored as sent: the catalogue is the client's, so there is nothing here to
  // validate a code against. Deduplicated because the composite key would
  // reject the whole write over a repeated code.
  const languageCodes = payload.language_codes && [...new Set(payload.language_codes)];
  if (languageCodes) {
    operations.push(
      prisma.userLanguage.deleteMany({ where: { userId: user.id } }),
      prisma.userLanguage.createMany({
        data: languageCodes.map((code) => ({
          userId: user.id,
          languageCode: code,
        })),
      })
    );
  }

  if (operations.length > 0) await prisma.$transaction(operations);

  // Which fields moved, not their contents. The timeline answers "what did
  // they change and when"; the current values are on the profile itself, and
  // copying a bio into an audit row would duplicate it for ever.
  const changed = Object.keys(data);
  if (changed.length > 0) {
    activity.record({
      userId: user.id,
      type: changed.includes('cityId') && changed.length === 1
        ? 'location_updated'
        : 'profile_updated',
      description: `Updated their profile — ${changed.join(', ')}`,
      metadata: { fields: changed, city_id: data.cityId ?? undefined },
    });
  }
  if (languageCodes) {
    activity.record({
      userId: user.id,
      type: 'language_updated',
      description: `Set their languages to ${languageCodes.join(', ')}`,
      metadata: { languages: languageCodes },
    });
  }

  return getMyProfile(user.id);
}

/**
 * Records presence and tells the people who care.
 *
 * Called by the socket layer on connect and disconnect, and by an explicit
 * REST call for a client that wants to go invisible without dropping its
 * socket.
 *
 * **Idempotent, and that is load-bearing.** Setting a status the profile
 * already has does nothing and tells nobody: no write, no admin event, no
 * `presence:changed` for anyone with an open conversation. That is what lets
 * the socket layer call this unconditionally on every connect, which is the
 * only way to be
 * sure a connected account is marked online. It used to guard the call with
 * "is this the only socket in the room", so a reconnect that raced an old,
 * not-yet-reaped socket skipped the update and left somebody offline to
 * everyone while their app sat there connected.
 *
 * The change is detected in the `updateMany` itself rather than by reading
 * first and then writing: two devices connecting in the same instant would
 * both read "offline", both decide they had changed something, and both
 * announce it.
 *
 * Two audiences are notified: everyone with an open conversation (a chat
 * list shows every peer's status, whether or not it is on screen), and
 * whoever has this person on screen *right now* — a discovery card or a
 * profile — via `presence:watch`. Not everyone who has ever viewed a profile:
 * that would be a firehose, and a watch ends when the screen does.
 */
async function setPresence(userId, status) {
  const { count } = await prisma.userProfile.updateMany({
    where: { userId, presence: { not: status } },
    data: {
      presence: status,
      // Only meaningful when going offline; keeping it fresh on every change
      // means "last seen" is right even if the process dies mid-session.
      lastSeen: new Date(),
    },
  });

  const profile = await prisma.userProfile.findUnique({
    where: { userId },
    select: { presence: true, lastSeen: true, userId: true },
  });

  // Already in that state, or no such profile. Either way there is nothing to
  // announce — the caller still gets the row, because the REST endpoint
  // answers with it.
  if (count === 0 || !profile) return profile;

  // The admin panel sees every presence change, including from accounts that
  // hide their status from other users. That is not a privacy hole being
  // opened — the operator can already read the column — and an online-user
  // count that silently excluded the people who opted out would be wrong.
  emitToAdmin('admin:presence_changed', {
    user_id: userId,
    status: profile.presence,
    at: profile.lastSeen?.toISOString() ?? new Date().toISOString(),
  });

  const privacy = await prisma.privacySettings.findUnique({
    where: { userId },
    select: { showOnlineStatus: true },
  });

  // Hiding presence means nobody is told about the change — publishing it and
  // trusting each client to ignore it would leak exactly what was hidden.
  if (privacy?.showOnlineStatus !== false) {
    const payload = {
      user_id: userId,
      status: profile.presence,
      last_seen: profile.lastSeen?.toISOString() ?? null,
    };
    const peerIds = await relationship.conversationPeerIdsFor(userId);
    if (peerIds.size > 0) emitToUsers([...peerIds], 'presence:changed', payload);
    emitToPresenceWatchers(userId, 'presence:changed', payload);
  }

  return profile;
}

/**
 * Marks everybody offline, for a process that has just started.
 *
 * Presence is a fact about a live socket, and a freshly booted process holds
 * none — so anything still recorded as online is a leftover from a run that
 * was killed before its disconnect handlers could fire, which is every
 * ungraceful restart and every redeploy. Left alone those accounts advertise
 * themselves as available for ever.
 *
 * Runs before the server accepts connections, so it cannot race a client that
 * has genuinely just reconnected.
 *
 * No account is exempt. The demo profiles used to be, which meant thirteen of
 * them sat permanently "online" with nothing connected — a status that was
 * decoration rather than a fact, on the one screen where the whole point is
 * that the number is real.
 */
async function resetAllPresence() {
  const { count } = await prisma.userProfile.updateMany({
    where: { presence: { not: 'offline' } },
    data: { presence: 'offline' },
  });
  return count;
}

/**
 * Points this user's profile at one of the predefined avatars.
 *
 * There is nothing to store and nothing to delete — every account choosing
 * `male_01` points at the same file, so switching away from it never leaves
 * an orphaned object the way a real upload would. Just a single column
 * write, validated against the catalog so a stale or invented id can never
 * land in the database.
 */
async function setAvatarId(userId, avatarId) {
  if (!avatarCatalog.isValid(avatarId)) {
    throw errors.notFound('Avatar', 'AVATAR_NOT_FOUND');
  }

  // A missing profile surfaces as Prisma's own P2025, already mapped to a
  // 404 by the global error handler.
  await prisma.userProfile.update({ where: { userId }, data: { avatarId } });

  return getMyProfile(userId);
}

module.exports = {
  getMyProfile,
  setAvatarId,
  getPublicProfile,
  updateProfile,
  setPresence,
  resetAllPresence,
};
