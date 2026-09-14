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
 * How many registered members each city has, per city id.
 *
 * The whole of what this server still knows about cities. The catalogue — id,
 * name, state, coordinates — is compiled into the mobile app, because it is
 * static reference data and a picker that has to wait on a network call to
 * draw itself is a picker that shows a blank screen whenever the call fails.
 * This is the one thing about a city the app cannot work out for itself, and
 * the one thing that actually changes.
 *
 * A membership count, not a discovery preview. Two filters used to narrow it
 * to the people a discovery feed would return, and both made the picker
 * disappear:
 *
 *  * `presence: 'online'` emptied it the moment nobody happened to be
 *    connected, so the whole of India read as "nobody here" on a quiet
 *    evening.
 *  * `isEarner: true` dropped every city whose members are all callers —
 *    two thirds of the accounts here, and entire cities with them.
 *
 * Somebody opening this is choosing where to look, and that is a question
 * about where people have signed up, not about who is connected this second
 * or which side of the marketplace they are on.
 *
 * What remains is only the conditions under which an account is not a member
 * at all: deleted, suspended, still mid-onboarding, or explicitly hidden by
 * its owner. A hidden profile stays out because being counted in a city is
 * still saying that somebody is there.
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
