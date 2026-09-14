'use strict';

const prisma = require('../config/prisma');

/**
 * The reference data this server still owns.
 *
 * Almost none of it. Both catalogues the app draws from — cities and languages
 * — are static, so both ship compiled into the app and neither is served from
 * here. What is left is the two things a catalogue cannot state about itself:
 * how many people are in a city right now, and which language codes one
 * account chose.
 */

function getUserLanguages(userId) {
  return prisma.userLanguage.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * How many discoverable earners are online, per city id.
 *
 * The whole of what this server still knows about cities. The catalogue — id,
 * name, state, coordinates — is compiled into the mobile app, because it is
 * static reference data and a picker that has to wait on a network call to
 * draw itself is a picker that shows a blank screen whenever the call fails.
 * This is the one thing about a city the app cannot work out for itself, and
 * the one thing that actually changes.
 *
 * Who is *registered* there, not who is online there. Presence is deliberately
 * not part of this: a city picker filtered on it empties out the moment nobody
 * happens to be connected, so the whole of India reads as "nobody here" on a
 * quiet evening and there is nowhere to browse to. Somebody choosing a city is
 * choosing where to look, and that is a question about where people live.
 *
 * Everything else discovery requires is still applied — visible, onboarded
 * earners — because those decide whether a profile can be shown at all. A
 * count that included people discovery would never return is the same broken
 * promise in the other direction. It was a written-down number once: "18,210
 * in Bangalore" on a platform with twenty-two accounts.
 *
 * Only cities with somebody in them appear. An absent id means zero, which is
 * the honest encoding and keeps this to the handful of cities that have
 * anybody rather than all 224.
 */
async function cityStats() {
  const counts = await prisma.userProfile.groupBy({
    by: ['cityId'],
    where: {
      cityId: { not: null },
      isEarner: true,
      onboardingStatus: 'ONBOARDING_COMPLETED',
      user: {
        status: 'active',
        deletedAt: null,
        privacySettings: { profileVisibleToEveryone: true },
      },
    },
    _count: { cityId: true },
  });

  return Object.fromEntries(counts.map((c) => [c.cityId, c._count.cityId]));
}

module.exports = {
  getUserLanguages,
  cityStats,
};
