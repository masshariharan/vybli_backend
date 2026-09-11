'use strict';

const env = require('../config/env');

/**
 * State and district for a coordinate, via OpenStreetMap's Nominatim.
 *
 * Server-side because the client's on-device geocoder (Play Services on
 * Android) is unreliable for exactly the coordinates this matters most for —
 * a village fix routinely comes back with no district at all, because that
 * database is built for cities. Nominatim's data is OpenStreetMap's own
 * administrative boundary polygons, drawn to district level across India
 * regardless of population.
 *
 * Never throws. This is a label on a screen the user already has a city on;
 * an outage or a malformed response here must not take detection down with it.
 */

const TIMEOUT_MS = 5000;

/** A district's boundary does not move; a day's staleness costs nothing. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 2000;
const cache = new Map();

/**
 * Nominatim's usage policy caps this at one request per second, for the whole
 * process rather than per caller. Serialised through a single promise chain
 * rather than a queue library — what reaches this is "somebody just tapped
 * 'use my location'", not a batch job with a backlog to manage.
 */
const MIN_INTERVAL_MS = 1100;
let chain = Promise.resolve();
let lastRequestAt = 0;

function throttled(fn) {
  const run = chain.then(async () => {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
    return fn();
  });
  // Detached from the returned promise so one caller's failure does not wedge
  // every request queued behind it.
  chain = run.then(
    () => {},
    () => {}
  );
  return run;
}

/**
 * Rounded to three decimal places — about 100m, tight enough to stay inside
 * one district, loose enough that a handful of taps from the same spot share
 * one cache entry and one Nominatim request instead of one each.
 */
function cacheKey(latitude, longitude) {
  return `${latitude.toFixed(3)},${longitude.toFixed(3)}`;
}

/**
 * `{ state, district }` for a coordinate, or null when it is switched off, the
 * lookup failed, or Nominatim had neither field for that spot.
 */
async function reverseGeocode({ latitude, longitude }) {
  if (!env.reverseGeocode.configured) return null;

  const key = cacheKey(latitude, longitude);
  const cached = cache.get(key);
  if (cached && cached.at > Date.now() - CACHE_TTL_MS) return cached.value;

  let value = null;
  try {
    value = await throttled(() => _lookupNominatim(latitude, longitude));
  } catch {
    value = null;
  }

  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function _lookupNominatim(latitude, longitude) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(
      'https://nominatim.openstreetmap.org/reverse' +
        `?format=jsonv2&lat=${latitude}&lon=${longitude}&zoom=10&addressdetails=1`,
      {
        signal: controller.signal,
        headers: { 'User-Agent': env.reverseGeocode.userAgent },
      }
    );
    if (!response.ok) return null;

    const body = await response.json();
    const address = body && body.address;
    if (!address) return null;

    // India's district is `state_district` in OSM's tagging most of the time;
    // `county` and `district` cover the places that tag it differently.
    const district =
      address.state_district || address.county || address.district || null;
    const state = address.state || null;

    return district || state ? { district, state } : null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { reverseGeocode };
