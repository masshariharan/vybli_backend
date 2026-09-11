'use strict';

const prisma = require('../config/prisma');
const relationship = require('./relationship.service');
const { emitToUsers } = require('../sockets/bus');

/**
 * Settings.
 *
 * A setting that is stored and read by nothing is not a setting, it is a
 * decoration — so each write here has a consequence beyond the row itself:
 *
 *  * Turning a call type off updates the **profile** flags too, which is what
 *    discovery and the call guard actually read. Two fields that could
 *    disagree would mean a profile advertising video while its owner has video
 *    switched off.
 *  * Hiding presence pushes an immediate `offline` to friends. Waiting for the
 *    next natural change would leave the old status on their screens.
 */

const camelFromSnake = {
  profile_visible_to_everyone: 'profileVisibleToEveryone',
  show_online_status: 'showOnlineStatus',
  show_city_on_profile: 'showCityOnProfile',
  allow_voice_calls: 'allowVoiceCalls',
  allow_video_calls: 'allowVideoCalls',
  allow_messages: 'allowMessages',
};

function mapKeys(payload, mapping) {
  const data = {};
  for (const [snake, camel] of Object.entries(mapping)) {
    if (payload[snake] !== undefined) data[camel] = payload[snake];
  }
  return data;
}

async function getPrivacy(userId) {
  return (
    (await prisma.privacySettings.findUnique({ where: { userId } })) ??
    prisma.privacySettings.create({ data: { userId } })
  );
}

async function updatePrivacy(userId, payload) {
  const data = mapKeys(payload, camelFromSnake);

  const operations = [
    prisma.privacySettings.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    }),
  ];

  // Keep the profile's advertised call types in step with the privacy switches
  // that govern them.
  const profileData = {};
  if (data.allowVoiceCalls !== undefined) profileData.voiceEnabled = data.allowVoiceCalls;
  if (data.allowVideoCalls !== undefined) profileData.videoEnabled = data.allowVideoCalls;
  if (Object.keys(profileData).length > 0) {
    operations.push(
      prisma.userProfile.update({ where: { userId }, data: profileData })
    );
  }

  const [settings] = await prisma.$transaction(operations);

  if (data.showOnlineStatus !== undefined) {
    await broadcastPresenceVisibility(userId, data.showOnlineStatus);
  }

  return settings;
}

/**
 * Tells friends that this person's presence just became visible or hidden.
 *
 * Hiding sends a synthetic `offline`, which is the honest projection of "you
 * may no longer know". Un-hiding sends the real value back.
 */
async function broadcastPresenceVisibility(userId, visible) {
  const friendIds = await relationship.friendIdsFor(userId);
  if (friendIds.size === 0) return;

  const profile = await prisma.userProfile.findUnique({
    where: { userId },
    select: { presence: true, lastSeen: true },
  });

  emitToUsers([...friendIds], 'presence:changed', {
    user_id: userId,
    status: visible ? profile?.presence ?? 'offline' : 'offline',
    last_seen: visible ? profile?.lastSeen?.toISOString() ?? null : null,
  });
}

// ── Notifications ───────────────────────────────────────────────────────────

const notificationKeys = {
  incoming_calls: 'incomingCalls',
  missed_calls: 'missedCalls',
  messages: 'messages',
  new_matches: 'newMatches',
  earnings: 'earnings',
  promotions: 'promotions',
};

async function getNotifications(userId) {
  return (
    (await prisma.notificationSettings.findUnique({ where: { userId } })) ??
    prisma.notificationSettings.create({ data: { userId } })
  );
}

function updateNotifications(userId, payload) {
  const data = mapKeys(payload, notificationKeys);
  return prisma.notificationSettings.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });
}

// ── Discovery ───────────────────────────────────────────────────────────────

const discoveryKeys = {
  min_age: 'minAge',
  max_age: 'maxAge',
  languages: 'languages',
  voice_calls: 'voiceCalls',
  video_calls: 'videoCalls',
};

async function getDiscovery(userId) {
  return (
    (await prisma.discoverySettings.findUnique({ where: { userId } })) ??
    prisma.discoverySettings.create({ data: { userId } })
  );
}

async function updateDiscovery(userId, payload) {
  const data = mapKeys(payload, discoveryKeys);

  // A partial update must still produce a coherent range — sending only
  // `min_age: 50` against a stored max of 45 would save an empty window that
  // matches nobody.
  if (data.minAge !== undefined || data.maxAge !== undefined) {
    const current = await getDiscovery(userId);
    const min = data.minAge ?? current.minAge;
    const max = data.maxAge ?? current.maxAge;
    if (min > max) {
      data.minAge = Math.min(min, max);
      data.maxAge = Math.max(min, max);
    }
  }

  return prisma.discoverySettings.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });
}

function resetDiscovery(userId) {
  return prisma.discoverySettings.upsert({
    where: { userId },
    create: { userId },
    update: {
      minAge: 18,
      maxAge: 45,
      genders: ['male', 'female'],
      languages: [],
      voiceCalls: true,
      videoCalls: true,
    },
  });
}

module.exports = {
  getPrivacy,
  updatePrivacy,
  getNotifications,
  updateNotifications,
  getDiscovery,
  updateDiscovery,
  resetDiscovery,
};
