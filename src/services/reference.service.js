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
 * Registration, not a discovery preview. This deliberately does **not** ask
 * the question the feed asks, and every attempt to make it do so emptied the
 * picker:
 *
 *  * `presence: 'online'` emptied it the moment nobody happened to be
 *    connected, so the whole of India read as "nobody here" on a quiet
 *    evening.
 *  * `isEarner: true` dropped every city whose members are all callers —
 *    two thirds of the accounts here, and entire cities with them.
 *  * `profileVisibleToEveryone` made one person's privacy setting shrink a
 *    number describing everybody else in their city.
 *
 * Somebody opening this is choosing where to look, and that is a question
 * about where people have signed up — not who is connected this second, which
 * side of the marketplace they are on, or whether any one of them wants to be
 * listed. An aggregate says a city has members; it names nobody, so a hidden
 * profile is counted without being exposed.
 *
 * Two conditions remain, and both are about whether there is an account at
 * all rather than what it contains: the account is live (not deleted, not
 * suspended), and the signup finished. A half-built profile has no name and
 * no avatar yet, so counting it promises somebody who does not exist.
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
