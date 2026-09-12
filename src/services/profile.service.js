'use strict';

const prisma = require('../config/prisma');
const { errors } = require('../utils/errors');
const avatarCatalog = require('../config/avatarCatalog');
const activity = require('./activity.service');
const { USER_INCLUDE } = require('./auth.service');
const relationship = require('./relationship.service');
const { emitToUsers, emitToAdmin } = require('../sockets/bus');

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
 * relationship: hiding removes you from *discovery*, and a friend opening the
 * chat header should not hit a wall. A stranger who guessed the id gets a
 * not-found, which is also the honest answer to "is this person on Vybli".
 */
async function getPublicProfile(viewer, targetId) {
  const target = await relationship.loadCounterpart(targetId);

  if (await relationship.isBlockedEitherWay(viewer.id, targetId)) {
    throw errors.notFound('That person', 'USER_NOT_FOUND');
  }

  const hidden = target.privacySettings?.profileVisibleToEveryone === false;
  if (hidden && viewer.id !== targetId) {
    const known =
      (await relationship.areFriends(viewer.id, targetId)) ||
      (await relationship.connectionStatus(viewer.id, targetId)) !== 'none';
    if (!known) throw errors.notFound('That person', 'USER_NOT_FOUND');
  }

  const [status, languages] = await Promise.all([
    relationship.connectionStatus(viewer.id, targetId),
    prisma.userLanguage.findMany({
      where: { userId: targetId },
      include: { language: true },
    }),
  ]);

  return { user: { ...target, languages }, connectionStatus: status };
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

  if (payload.city_id !== undefined) {
    const city = await prisma.city.findUnique({ where: { id: payload.city_id } });
    if (!city) throw errors.notFound('City', 'CITY_NOT_FOUND');
    data.cityId = payload.city_id;
  }

  const operations = [];
  if (Object.keys(data).length > 0) {
    operations.push(prisma.userProfile.update({ where: { userId: user.id }, data }));
  }

  if (payload.language_codes) {
    const known = await prisma.language.findMany({
      where: { code: { in: payload.language_codes } },
      select: { code: true },
    });
    if (known.length !== payload.language_codes.length) {
      const knownSet = new Set(known.map((l) => l.code));
      throw errors.badRequest('Some of those languages are not available', {
        unknown: payload.language_codes.filter((c) => !knownSet.has(c)),
      });
    }
    operations.push(
      prisma.userLanguage.deleteMany({ where: { userId: user.id } }),
      prisma.userLanguage.createMany({
        data: payload.language_codes.map((code) => ({
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
  if (payload.language_codes) {
    activity.record({
      userId: user.id,
      type: 'language_updated',
      description: `Set their languages to ${payload.language_codes.join(', ')}`,
      metadata: { languages: payload.language_codes },
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
 * Only friends are notified. Broadcasting to everyone who has ever viewed a
 * profile would be a firehose, and friends are the only people with a surface
 * that shows live presence.
 */
async function setPresence(userId, status) {
  const profile = await prisma.userProfile.update({
    where: { userId },
    data: {
      presence: status,
      // Only meaningful when going offline; keeping it fresh on every change
      // means "last seen" is right even if the process dies mid-session.
      lastSeen: new Date(),
    },
    select: { presence: true, lastSeen: true, userId: true },
  });

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
    const friendIds = await relationship.friendIdsFor(userId);
    if (friendIds.size > 0) {
      emitToUsers([...friendIds], 'presence:changed', {
        user_id: userId,
        status: profile.presence,
        last_seen: profile.lastSeen?.toISOString() ?? null,
      });
    }
  }

  return profile;
}

/**
 * Marks everyone offline at boot — a crash leaves stale `online` rows behind.
 *
 * Seeded demo accounts are exempt. Their presence is **fixture data**, not the
 * shadow of a socket: nobody ever connects as one, so resetting them left the
 * feed full of people who could never be called and random matching with
 * nothing to match. They are answered for by the demo responder, which does
 * not need a connection to do it.
 */
async function resetAllPresence() {
  const { count } = await prisma.userProfile.updateMany({
    where: { presence: { not: 'offline' }, isDemo: false },
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
