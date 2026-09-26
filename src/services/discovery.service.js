'use strict';

const prisma = require('../config/prisma');
const { errors } = require('../utils/errors');
const relationship = require('./relationship.service');
const { pageAcrossBuckets } = require('../utils/paging');
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
  profile: true,
  privacySettings: true,
  languages: true,
};

/**
 * Everyone who may appear in `viewer`'s discovery.
 *
 * Which sides appear is `utils/pairing`, and differs by surface:
 *  * the **feed** ([feed]) uses `visibleSideWhere` — the other side (Earn
 *    Money ↔ Make Friends, which onboarding derives from gender) always, and
 *    the viewer's own side too when *they* have "Show All Users" on;
 *  * **random match** uses `pairableWhere` — somebody it can ring right now,
 *    so a same-side match also needs the switch on for *them*, exactly the
 *    rule the call guard enforces.
 *
 * Beyond that role split, three conditions, each load-bearing:
 *  * `ONBOARDING_COMPLETED` — a half-built profile has no name or city.
 *  * `profileVisibleToEveryone` — the privacy switch, enforced in the query
 *    rather than filtered afterwards, so it also governs the total count.
 *  * live account — not deleted, not suspended.
 *
 * There was a fourth, excluding seeded demo profiles. The seeder is gone:
 * every account in this database belongs to somebody who signed up, so there
 * is no longer a category of row that has to be hidden from real users.
 */
function visibleWhere(viewer, { callable = false } = {}) {
  return {
    status: 'active',
    deletedAt: null,
    privacySettings: { profileVisibleToEveryone: true },
    profile: { onboardingStatus: 'ONBOARDING_COMPLETED' },
    // Under `AND`, not merged into `profile`/`privacySettings`: both callers
    // below replace those two keys wholesale with their own conditions, and
    // the pairing rule must survive that.
    AND: [
      callable
        ? relationship.pairableWhere(viewer)
        : relationship.visibleSideWhere(viewer),
    ],
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
  // Gender is not a filter here — [visibleWhere] already decided it from the
  // viewer's role and their "Show All Users" setting.
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

  // By code, which is what both sides store. This used to join to the
  // catalogue's `name` column, so the filter matched on a display string and
  // returned nobody the moment the client's spelling and the row's differed —
  // an empty feed with nothing to say why.
  if (languages?.length) {
    where.languages = { some: { languageCode: { in: languages } } };
  }

  // Online first, then busy, then offline — each its own bucket, paged
  // across as one list (`utils/paging`). This used to order by the
  // `presence` enum in SQL, which sorts in *declaration* order (online,
  // offline, busy), and then re-sort each page in JavaScript. The two
  // disagreed across pages: page two could open with a busy card that
  // belonged above the offline ones already shown at the end of page one.
  //
  // Within a bucket: best rated, newest, then `id` — unique, so two people
  // who tie on everything else keep their places between requests and nobody
  // is shown twice or skipped as the next page loads.
  const orderBy = [
    { profile: { rating: 'desc' } },
    { createdAt: 'desc' },
    { id: 'desc' },
  ];
  const inPresence = (presence) => ({
    where: { AND: [where, { profile: { presence } }] },
    orderBy,
  });

  // A presence filter already narrows the feed to one bucket; asking the
  // other two would only count rows that cannot match.
  const presences = params.online_only ? ['online'] : ['online', 'busy', 'offline'];

  const { rows, total } = await pageAcrossBuckets(prisma.user, {
    buckets: presences.map(inPresence),
    include: PROFILE_INCLUDE,
    skip: params.skip,
    take: params.take,
  });

  return { rows, total };
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
    ...visibleWhere(user, { callable: true }).profile,
    presence: 'online',
    ...(type === 'voice' ? { voiceEnabled: true } : { videoEnabled: true }),
  };
  if (resolvedCityId) profileWhere.cityId = resolvedCityId;

  const where = {
    ...visibleWhere(user, { callable: true }),
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
