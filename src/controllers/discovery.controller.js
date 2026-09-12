'use strict';

const discoveryService = require('../services/discovery.service');
const referenceService = require('../services/reference.service');
const avatarCatalog = require('../config/avatarCatalog');
const geoip = require('../services/geoip.service');
const nominatim = require('../services/nominatim.service');
const favoriteService = require('../services/favorite.service');
const serialize = require('../utils/serialize');
const { ok, paginated } = require('../utils/respond');
const { q } = require('../middleware/validate');
const { toSkipTake } = require('../validators/common');

/** The Home feed. */
async function feed(req, res) {
  const params = q(req);
  const { skip, take } = toSkipTake(params);

  const [{ rows, total, reason }, favoriteIds] = await Promise.all([
    discoveryService.feed(req.user, { ...params, skip, take }),
    favoriteService.favoriteIdsFor(req.userId),
  ]);

  const body = rows.map((u) =>
    serialize.publicUser(u, {
      viewer: req.userId,
      viewerProfile: req.user.profile,
      favorited: favoriteIds.has(u.id),
    })
  );

  // An empty feed has more than one cause, and the client's empty state reads
  // differently for each — "widen your filters" is unhelpful advice when the
  // real problem is that both call types are switched off.
  if (reason) {
    return ok(
      res,
      {
        items: body,
        pagination: { page: params.page, limit: params.limit, total: 0, total_pages: 0, has_next: false, has_previous: false },
        empty_reason: reason,
      },
      'No one to show'
    );
  }

  return paginated(res, body, { page: params.page, limit: params.limit, total });
}

/**
 * One random person to call.
 *
 * Returns the match only — placing the call is a separate, explicit step, so
 * the user can skip without having dialled anyone.
 */
async function randomMatch(req, res) {
  const match = await discoveryService.randomMatch(req.user, {
    scope: req.body.scope,
    cityId: req.body.city_id,
    type: req.body.type,
    excludeIds: req.body.exclude_ids,
  });
  // Who the match is isn't known until the query above returns, so this
  // can't run any earlier alongside it.
  const favorited = await favoriteService.isFavorite(req.userId, match.id);
  // The earner's rate, whichever side of the match that is — see
  // `serialize.publicUser`'s `viewerProfile` doc for why.
  const rateOwner = req.user.profile?.isEarner ? req.user.profile : match.profile;

  return ok(
    res,
    {
      user: serialize.publicUser(match, {
        viewer: req.userId,
        viewerProfile: req.user.profile,
        favorited,
      }),
      type: req.body.type,
      rate_per_minute: Number(
        req.body.type === 'voice' ? rateOwner.voiceRatePerMinute : rateOwner.videoRatePerMinute
      ),
    },
    'Match found'
  );
}

// ── Reference data ──────────────────────────────────────────────────────────

async function cities(req, res) {
  const params = q(req);
  const rows = await referenceService.listCities({
    q: params.q,
    popularOnly: params.popular_only,
    hasUsers: params.has_users,
    latitude: params.lat,
    longitude: params.lng,
  });
  return ok(
    res,
    {
      cities: rows.map((c) => serialize.city(c, c.activeUsers)),
      total: rows.length,
    },
    'Cities'
  );
}

/** The predefined avatar catalog — see `config/avatarCatalog`. */
async function avatars(req, res) {
  const params = q(req);
  const rows = avatarCatalog.list(params.gender);
  return ok(res, { avatars: rows.map(serialize.avatar), total: rows.length }, 'Avatars');
}

/**
 * Which city a coordinate is in.
 *
 * Answers `{ city: null }` rather than an error when nothing is close enough.
 * "We cannot tell" is a normal outcome — the user is outside every city the
 * platform serves — and the client's response to it is to ask, not to retry.
 */
async function nearestCity(req, res) {
  const params = q(req);

  let latitude = params.lat;
  let longitude = params.lng;
  let source = 'device';

  // No coordinate means the phone could not produce one. An IP is a much
  // rougher answer, but it is available to every caller and needs no
  // permission — and a rough city the user confirms beats asking someone who
  // has no idea which of two hundred names is nearest.
  if (latitude === undefined || longitude === undefined) {
    const byIp = await geoip.locate(req.ip);
    if (!byIp) {
      return ok(
        res,
        { city: null, distance_km: null, source: 'none' },
        'Could not work out where you are'
      );
    }
    latitude = byIp.latitude;
    longitude = byIp.longitude;
    source = 'ip';
  }

  // Ahead of the city match, not alongside it: the state this resolves to is
  // what keeps a border coordinate from being matched to the nearest city in
  // the *wrong* state. Only for a real device fix — an IP-derived point is
  // already a rough guess at which city someone is near, and reverse-geocoding
  // it would dress that same guess up as something more precise than it is.
  const place =
    source === 'device' ? await nominatim.reverseGeocode({ latitude, longitude }) : null;

  const match = await referenceService.nearestCity({
    latitude,
    longitude,
    preferState: place?.state ?? null,
  });

  if (!match) {
    return ok(
      res,
      {
        city: null,
        distance_km: null,
        source,
        district: place?.district ?? null,
        state: place?.state ?? null,
      },
      'No city near that location'
    );
  }

  return ok(
    res,
    {
      city: serialize.city(match.city),
      distance_km: match.distanceKm,
      // The client says "from your location" for a device fix and hedges for
      // an IP one, because a carrier gateway can put a rural subscriber in the
      // nearest metro and the user needs to know which claim they are checking.
      source,
      // Independent of `city`, which is the nearest of our own seeded list and
      // can be some real distance away wherever that list is sparse — this is
      // what the coordinate actually administratively sits in.
      district: place?.district ?? null,
      state: place?.state ?? null,
    },
    'Nearest city'
  );
}

module.exports = { feed, randomMatch, cities, avatars, nearestCity };
