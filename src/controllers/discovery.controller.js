'use strict';

const discoveryService = require('../services/discovery.service');
const referenceService = require('../services/reference.service');
const avatarCatalog = require('../config/avatarCatalog');
const geoip = require('../services/geoip.service');
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

/**
 * "People online here", per city id.
 *
 * All that is left of `GET /cities`. The catalogue itself — names, states,
 * coordinates — is compiled into the app, so the only thing still worth asking
 * this server for is the figure that moves.
 */
async function cityStats(req, res) {
  const counts = await referenceService.cityStats();
  return ok(res, { counts }, 'City stats');
}

/** The predefined avatar catalog — see `config/avatarCatalog`. */
async function avatars(req, res) {
  const params = q(req);
  const rows = avatarCatalog.list(params.gender);
  return ok(res, { avatars: rows.map(serialize.avatar), total: rows.length }, 'Avatars');
}

/**
 * A rough coordinate for the caller's address.
 *
 * **Not a city.** Which city a point is in is decided on the phone, against
 * the catalogue the app carries — this answers only the one question a handset
 * genuinely cannot answer about itself, because behind carrier NAT it sees a
 * private address and never its own public one.
 *
 * This replaced `GET /cities/nearest`, which took the phone's coordinate,
 * forwarded it to a third-party reverse geocoder for a state, matched it
 * against a table here and returned a city. Every part of that the phone
 * already had: it holds the fix, and its own geocoder names the state without
 * a network. What was left was a round trip that leaked a precise location and
 * returned nothing at all when the table behind it was unseeded.
 *
 * Answers `{ lat: null, lng: null }` rather than an error when it cannot tell.
 * "We cannot say" is a normal outcome — no provider configured, a private
 * address, a failed lookup — and the client's response is to ask the user,
 * not to retry.
 */
async function ipEstimate(req, res) {
  const at = await geoip.locate(req.ip);
  if (!at) {
    return ok(res, { lat: null, lng: null }, 'Could not work out where you are');
  }
  return ok(res, { lat: at.latitude, lng: at.longitude }, 'Approximate location');
}

module.exports = { feed, randomMatch, cityStats, avatars, ipEstimate };
