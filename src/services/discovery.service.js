'use strict';

const prisma = require('../config/prisma');
const env = require('../config/env');
const { errors } = require('../utils/errors');
const relationship = require('./relationship.service');
const settingsService = require('./settings.service');

/**
 * The Home feed and random matching.
 *
 * Who is eligible to be shown is a single predicate, [visibleWhere], and both
 * surfaces use it. They differ only in how they pick from the result: the
 * feed pages through it, matching takes one at random from those online.
 * Keeping the eligibility in one place is why a person hidden from discovery
 * cannot turn up as a random match.
 */

const PROFILE_INCLUDE = {
  profile: { include: { city: true } },
  privacySettings: true,
  languages: { include: { language: true } },
};

/**
 * Everyone who may appear in `viewer`'s discovery.
 *
 * Earning is a role, not a preference: an Earn Money account's feed shows
 * Make Friends accounts and vice versa, because that is the only pairing the
 * call billing understands (one side earns, the other spends money) — two
 * earners or two non-earners are never shown to each other.
 *
 * Beyond that role split, four conditions, each load-bearing:
 *  * `ONBOARDING_COMPLETED` — a half-built profile has no name or city.
 *  * `profileVisibleToEveryone` — the privacy switch, enforced in the query
 *    rather than filtered afterwards, so it also governs the total count.
 *  * live account — not deleted, not suspended.
 *  * not a seeded profile — `seed-demo.js` writes 22 accounts so a developer
 *    has somebody to call, and they are not people. Production forces
 *    `showSeededProfiles` off, so this predicate is what stops a real user
 *    being offered one. Enforced in the query rather than filtered afterwards,
 *    for the same reason as the privacy switch: it has to govern the count and
 *    the random-match offset too, or the feed reports a total it cannot show
 *    and matching picks a row that gets discarded.
 */
function visibleWhere(viewer) {
  return {
    status: 'active',
    deletedAt: null,
    privacySettings: { profileVisibleToEveryone: true },
    profile: {
      isEarner: !viewer.profile?.isEarner,
      onboardingStatus: 'ONBOARDING_COMPLETED',
      ...(env.demo.showSeededProfiles ? {} : { isDemo: false }),
    },
  };
}

/** Turns a scope into the city filter it means. */
function resolveCityId({ scope, cityId, homeCityId }) {
  switch (scope) {
    case 'allCities':
      return null;
    case 'selectedCity':
      return cityId ?? homeCityId ?? null;
    case 'myCity':
    default:
      return homeCityId ?? null;
  }
}

/**
 * The discovery feed.
 *
 * Filters come from the user's saved Discovery Settings, with per-request
 * overrides for one-off filtering. Blocked people are excluded by id — the
 * list is small and a NOT IN is cheaper than a correlated subquery.
 *
 * Sorted online-first: a feed of offline people you cannot call is not a feed.
 */
async function feed(user, params) {
  const saved = await settingsService.getDiscovery(user.id);
  const blockedIds = await relationship.blockedIdsFor(user.id);

  const minAge = params.min_age ?? saved.minAge;
  const maxAge = params.max_age ?? saved.maxAge;
  const languages = params.languages ?? saved.languages;

  // Both call types off means nobody qualifies — the client warns about this,
  // and the server agrees rather than quietly ignoring it.
  const wantsVoice = saved.voiceCalls;
  const wantsVideo = saved.videoCalls;
  if (!wantsVoice && !wantsVideo) {
    return { rows: [], total: 0, reason: 'NO_CALL_TYPES_ENABLED' };
  }

  const cityId = resolveCityId({
    scope: params.scope,
    cityId: params.city_id,
    homeCityId: user.profile?.cityId,
  });

  // Spread first: `where.profile` below replaces this object wholesale, so the
  // eligibility conditions have to be restated here or they are lost.
  // Gender is not a filter here — [visibleWhere] already fixed it to the
  // opposite of the viewer's own role, and picking within that pool is not a
  // choice the app offers any more.
  const profileWhere = {
    ...visibleWhere(user).profile,
    age: { gte: minAge, lte: maxAge },
  };
  if (cityId) profileWhere.cityId = cityId;
  if (params.online_only) profileWhere.presence = 'online';
  if (params.q?.trim()) {
    profileWhere.name = { contains: params.q.trim(), mode: 'insensitive' };
  }

  // Filtering on one call type only shows people who offer it. With both on,
  // anyone offering either qualifies.
  if (wantsVoice && !wantsVideo) profileWhere.voiceEnabled = true;
  if (wantsVideo && !wantsVoice) profileWhere.videoEnabled = true;

  const where = {
    ...visibleWhere(user),
    profile: profileWhere,
    id: { notIn: [user.id, ...blockedIds] },
  };

  if (languages?.length) {
    where.languages = { some: { language: { name: { in: languages } } } };
  }

  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      include: PROFILE_INCLUDE,
      orderBy: [
        // Online first, then busy, then offline — `online` sorts before
        // `offline` alphabetically, and `busy` before both, so the enum is
        // ordered explicitly instead.
        { profile: { presence: 'asc' } },
        { profile: { rating: 'desc' } },
        { createdAt: 'desc' },
      ],
      skip: params.skip,
      take: params.take,
    }),
    prisma.user.count({ where }),
  ]);

  return { rows: sortByPresence(rows), total };
}

/** online → busy → offline. The enum's own order is not this. */
const PRESENCE_RANK = { online: 0, busy: 1, offline: 2 };
function sortByPresence(rows) {
  return [...rows].sort((a, b) => {
    const rank =
      PRESENCE_RANK[a.profile?.presence ?? 'offline'] -
      PRESENCE_RANK[b.profile?.presence ?? 'offline'];
    if (rank !== 0) return rank;
    return (b.profile?.rating ?? 0) - (a.profile?.rating ?? 0);
  });
}

/**
 * One random person to call.
 *
 * Only people who are online *and* offer the requested call type, because the
 * next thing that happens is a ring — matching someone who cannot take the
 * call turns "found!" into an immediate failure.
 *
 * `excludeIds` carries the people already skipped, so Skip does not re-offer
 * the same face.
 */
async function randomMatch(user, { scope, cityId, type, excludeIds = [] }) {
  const blockedIds = await relationship.blockedIdsFor(user.id);
  const resolvedCityId = resolveCityId({
    scope,
    cityId,
    homeCityId: user.profile?.cityId,
  });

  const profileWhere = {
    ...visibleWhere(user).profile,
    presence: 'online',
    ...(type === 'voice' ? { voiceEnabled: true } : { videoEnabled: true }),
  };
  if (resolvedCityId) profileWhere.cityId = resolvedCityId;

  const where = {
    ...visibleWhere(user),
    profile: profileWhere,
    privacySettings: {
      profileVisibleToEveryone: true,
      ...(type === 'voice' ? { allowVoiceCalls: true } : { allowVideoCalls: true }),
    },
    id: { notIn: [user.id, ...blockedIds, ...excludeIds] },
  };

  const count = await prisma.user.count({ where });
  if (count === 0) throw errors.noMatchAvailable();

  // Random offset rather than fetching everyone and picking in JS — the pool
  // is unbounded and only one row is wanted.
  const skip = Math.floor(Math.random() * count);
  const [match] = await prisma.user.findMany({
    where,
    include: PROFILE_INCLUDE,
    skip,
    take: 1,
  });

  if (!match) throw errors.noMatchAvailable();
  return match;
}

module.exports = { feed, randomMatch, visibleWhere, PROFILE_INCLUDE };
