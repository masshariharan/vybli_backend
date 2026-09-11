'use strict';

const env = require('../config/env');

/**
 * Where an IP address is, roughly.
 *
 * The fallback for when the phone cannot locate itself — and it is not a rare
 * case. GPS needs a view of the sky and a working receiver; network positioning
 * needs mapped wifi and masts. A user indoors, in a village, on a handset whose
 * GNSS is broken, or one who simply declines the permission gets nothing from
 * either. An IP is available to every one of them, costs no permission, and is
 * accurate to about the level this product asks: which of two hundred cities.
 *
 * **It is a suggestion, never an answer.** Mobile carriers in particular route
 * traffic through regional gateways, so a subscriber in a small town often
 * geolocates to the nearest metro — Jio and Airtel both do this. The client
 * pre-fills the result and makes the user confirm it, the same as a GPS fix,
 * which is what keeps a wrong guess harmless.
 *
 * Two providers, chosen by `GEOIP_PROVIDER`:
 *
 *  * `none` — off. No lookup, no third party, no fallback. The default,
 *    because sending user IP addresses somewhere should be a decision rather
 *    than something that happens by omission.
 *  * `ipapi` — ip-api.com. No key, no signup, generous free tier. Good enough
 *    to develop against and to run a small deployment on. It does mean each
 *    lookup sends the user's IP to a third party.
 *
 * For production at scale, MaxMind's GeoLite2 database is the better answer:
 * it is a local file, so no third party ever sees an IP and there is no rate
 * limit or network hop. It is a drop-in replacement for [_lookupIpApi] below.
 */

/** Long enough for a slow hop, short enough not to hold up the request. */
const TIMEOUT_MS = 4000;

/**
 * Results, kept briefly.
 *
 * The same handset retrying, or several users behind one carrier gateway, are
 * the common shapes here — and both would otherwise spend the free tier on an
 * answer that cannot have changed. Small and time-bounded rather than an LRU:
 * the working set is tiny and an entry going stale costs nothing.
 */
const cache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 500;

/**
 * True for addresses that cannot be geolocated by anyone.
 *
 * Every request in development comes from one of these, and asking a public
 * service where `127.0.0.1` is wastes a call to be told nothing.
 */
function isPrivate(ip) {
  if (!ip) return true;
  const clean = ip.replace(/^::ffff:/, '');
  return (
    clean === '127.0.0.1' ||
    clean === '::1' ||
    clean === 'localhost' ||
    clean.startsWith('10.') ||
    clean.startsWith('192.168.') ||
    clean.startsWith('169.254.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(clean) ||
    clean.startsWith('fc') ||
    clean.startsWith('fd')
  );
}

/**
 * The coordinate for an IP, or null when it cannot be determined.
 *
 * Never throws. This is a fallback: if it fails the caller is no worse off
 * than before it existed, and an outage at a geolocation service must not turn
 * into a failed sign-up.
 */
async function locate(ip) {
  if (!env.geoip.configured) return null;
  if (isPrivate(ip)) return null;

  const cached = cache.get(ip);
  if (cached && cached.at > Date.now() - CACHE_TTL_MS) return cached.value;

  let value = null;
  try {
    value = await _lookupIpApi(ip);
  } catch {
    // Swallowed deliberately — see above.
    value = null;
  }

  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(ip, { at: Date.now(), value });
  return value;
}

/**
 * ip-api.com.
 *
 * `fields` is a bitmask of just what is wanted; the default response carries a
 * dozen keys this does not use, including ones it would then be holding
 * needlessly. Http rather than https because the free tier does not offer TLS —
 * which is one more reason this is the development-grade option and MaxMind is
 * the production one.
 */
async function _lookupIpApi(ip) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,lat,lon,city,regionName`,
      { signal: controller.signal }
    );
    if (!response.ok) return null;

    const body = await response.json();
    if (body.status !== 'success') return null;
    if (typeof body.lat !== 'number' || typeof body.lon !== 'number') return null;

    return {
      latitude: body.lat,
      longitude: body.lon,
      // What the provider called it, for the log and for nothing else. The
      // city the user is given always comes from our own table, so a provider
      // naming a place we do not operate in cannot leak into a profile.
      label: [body.city, body.regionName].filter(Boolean).join(', ') || null,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { locate, isPrivate };
