'use strict';

const prisma = require('../config/prisma');

/**
 * Languages and cities.
 *
 * Both are seeded tables rather than constants in the app, so adding a
 * language is a row insert instead of a store release. Neither is
 * user-writable.
 */

/**
 * Language search.
 *
 * Matches `aliases` as well as the name, which is what makes "Bangla" find
 * Bengali and "Oriya" find Odia. A language somebody cannot find by the name
 * they grew up with reads as a language the app does not support.
 *
 * Ranked: exact match, then prefix, then anything containing the term — so
 * typing "ta" offers Tamil before Marathi.
 */
async function searchLanguages({ q, popularOnly = false } = {}) {
  const where = {};
  if (popularOnly) where.isPopular = true;

  const term = q?.trim().toLowerCase();
  if (term) {
    where.OR = [
      { name: { contains: term, mode: 'insensitive' } },
      { nativeName: { contains: term, mode: 'insensitive' } },
      { code: { equals: term, mode: 'insensitive' } },
      { aliases: { hasSome: [term] } },
    ];
  }

  const rows = await prisma.language.findMany({
    where,
    orderBy: [{ isPopular: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
  });

  if (!term) return rows;

  // Aliases are stored lowercase, but a user typing "Bang" should still match
  // "bangla" — so the containment pass happens here rather than in SQL.
  const scored = rows.map((row) => {
    const name = row.name.toLowerCase();
    const aliases = (row.aliases ?? []).map((a) => a.toLowerCase());
    let score = 3;
    if (name === term || aliases.includes(term)) score = 0;
    else if (name.startsWith(term) || aliases.some((a) => a.startsWith(term))) score = 1;
    else if (name.includes(term) || aliases.some((a) => a.includes(term))) score = 2;
    return { row, score };
  });

  return scored
    .sort((a, b) => a.score - b.score || a.row.name.localeCompare(b.row.name))
    .map((s) => s.row);
}

function getUserLanguages(userId) {
  return prisma.userLanguage.findMany({
    where: { userId },
    include: { language: true },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Cities, each with a live count of the earners discoverable in it.
 *
 * The count is the "people online here" figure the city picker shows, so it
 * counts what discovery would actually return — visible earners — rather than
 * every row with that city id, which would promise people who cannot be found.
 */
async function listCities({ q, popularOnly = false, hasUsers = false, latitude, longitude } = {}) {
  const where = {};
  if (popularOnly) where.isPopular = true;
  if (q?.trim()) {
    where.OR = [
      { name: { contains: q.trim(), mode: 'insensitive' } },
      { state: { contains: q.trim(), mode: 'insensitive' } },
    ];
  }

  // Discovery's own city filter — as opposed to onboarding's "where do you
  // live", which has to offer every city because a new signup may live
  // anywhere — only makes sense over cities someone has actually signed up
  // from. Any account counts here, not just the visible-online-earner
  // definition `activeUsers` below uses: a city with real accounts that
  // simply has nobody online right now is still a real place to filter by,
  // not an empty one.
  if (hasUsers) {
    const withAccounts = await prisma.userProfile.groupBy({
      by: ['cityId'],
      where: { cityId: { not: null } },
    });
    where.id = { in: withAccounts.map((row) => row.cityId) };
  }

  const [cities, counts] = await Promise.all([
    prisma.city.findMany({
      where,
      orderBy: [{ isPopular: 'desc' }, { name: 'asc' }],
    }),
    prisma.userProfile.groupBy({
      by: ['cityId'],
      where: {
        isEarner: true,
        presence: 'online',
        onboardingStatus: 'ONBOARDING_COMPLETED',
        user: { status: 'active', deletedAt: null, privacySettings: { profileVisibleToEveryone: true } },
      },
      _count: { cityId: true },
    }),
  ]);

  const byCity = new Map(counts.map((c) => [c.cityId, c._count.cityId]));
  const rows = cities.map((city) => ({
    ...city,
    activeUsers: byCity.get(city.id) ?? 0,
  }));

  // Without a coordinate the order is popular-first, which is the right
  // default for someone browsing. With one it is nearest-first, which is the
  // right order for someone answering "where do you live" — and the only
  // useful order for a user in a village, who is not in any of these cities
  // and needs to find the closest rather than recognise a name.
  if (latitude === undefined || longitude === undefined) return rows;

  return rows
    .map((city) => ({
      ...city,
      distanceKm:
        city.latitude === null || city.longitude === null
          ? null
          : Math.round(
              haversineKm(latitude, longitude, city.latitude, city.longitude) * 10
            ) / 10,
    }))
    .sort((a, b) => {
      // Cities with no coordinates cannot be ranked, so they keep their
      // popular-first order at the end rather than being dropped — a city you
      // cannot measure is still a city you may live in.
      if (a.distanceKm === null && b.distanceKm === null) return 0;
      if (a.distanceKm === null) return 1;
      if (b.distanceKm === null) return -1;
      return a.distanceKm - b.distanceKm;
    });
}

function getCity(cityId) {
  return prisma.city.findUnique({ where: { id: cityId } });
}

/**
 * The city nearest a coordinate, or null if none is close enough.
 *
 * Resolution happens **here, not on the phone**. The app sends a coarse
 * position and gets back a city id, so the coordinate is used once and never
 * stored — there is no column for it, and none is wanted. It also means the
 * answer can only ever be a city the platform actually operates in, which is
 * the whole question being asked.
 *
 * Computed in Node over the twenty-odd rows rather than in SQL. PostGIS would
 * be the answer at a thousand cities; at twenty it is an extension to install,
 * a migration to write and an index to maintain, for a query that takes
 * microseconds either way.
 *
 * [maxKm] is what stops a user in Colombo being told they are in
 * Thiruvananthapuram. Nearest-of-twenty always returns *something*, however
 * far away, and a confident wrong city is worse than admitting we cannot tell
 * — the caller falls back to asking.
 *
 * [preferState], when given, is tried first against only the cities in that
 * state. Straight-line nearest can cross a state line near a border — a point
 * in Villupuram district sitting closer to Puducherry's town coordinate than
 * to Villupuram's own — and a city from the wrong state is a worse answer
 * than a farther one from the right state, even though it is fewer
 * kilometres away. Falls through to the plain nearest-of-all search when the
 * state has nothing close enough, so a real border case still gets an answer.
 */
async function nearestCity({ latitude, longitude, maxKm = 150, preferState = null }) {
  const cities = await prisma.city.findMany({
    where: { isActive: true, latitude: { not: null }, longitude: { not: null } },
  });

  const nearestOf = (list) => {
    let best = null;
    let bestKm = Infinity;
    for (const city of list) {
      const km = haversineKm(latitude, longitude, city.latitude, city.longitude);
      if (km < bestKm) {
        bestKm = km;
        best = city;
      }
    }
    return best && bestKm <= maxKm
      ? { city: best, distanceKm: Math.round(bestKm * 10) / 10 }
      : null;
  };

  if (preferState) {
    const inState = nearestOf(cities.filter((c) => c.state === preferState));
    if (inState) return inState;
  }

  return nearestOf(cities);
}

const EARTH_RADIUS_KM = 6371;
const toRad = (deg) => (deg * Math.PI) / 180;

/**
 * Great-circle distance between two coordinates, in kilometres.
 *
 * Haversine rather than a flat-earth approximation: over the distances India
 * spans, treating degrees of longitude as a constant width is wrong by enough
 * to pick the wrong city — a degree of longitude is 111km at the equator and
 * 96km at Delhi's latitude.
 */
function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

module.exports = {
  searchLanguages,
  getUserLanguages,
  listCities,
  getCity,
  nearestCity,
  haversineKm,
};
