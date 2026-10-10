'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/**
 * Which Indian district and state a coordinate is in — by the official
 * boundaries, not by the nearest city.
 *
 * The boundaries are 2021's, from the Local Government Directory (see
 * `assets/geo/NOTICE.md`), built into `assets/geo/india-admin.json.gz` by
 * `scripts/build-india-admin.js`. Answered here, offline, rather than by a
 * geocoding service: no key, no per-request cost, nobody else is handed the
 * coordinate, and the same point always gets the same answer — which a
 * phone's geocoder does not promise (it often names the taluk, or nothing).
 *
 * Loaded on first use, once, and held in memory (a few tens of MB).
 */

const DATA = path.join(__dirname, '../../assets/geo/india-admin.json.gz');

/**
 * How far outside every boundary a point may be and still be given the
 * nearest district. The boundaries are simplified, so a point on a coast or
 * a border can fall a little way outside all of them; past this it is
 * genuinely elsewhere — at sea, or abroad — and has no district.
 */
const EDGE_TOLERANCE_KM = 3;
const KM_PER_DEG = 111.32;

let districts = null;

function load() {
  if (!districts) {
    districts = JSON.parse(zlib.gunzipSync(fs.readFileSync(DATA)).toString('utf8')).districts;
  }
  return districts;
}

/** Even-odd ray cast over all rings, so holes are excluded. */
function contains(polygons, lng, lat) {
  for (const rings of polygons) {
    let inside = false;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
        const xi = ring[i];
        const yi = ring[i + 1];
        const xj = ring[j];
        const yj = ring[j + 1];
        if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
          inside = !inside;
        }
      }
    }
    if (inside) return true;
  }
  return false;
}

/** Kilometres from the point to the nearest boundary segment. */
function kmToEdge(polygons, lng, lat) {
  // Flat-earth over a few kilometres: longitude scaled by latitude.
  const kx = KM_PER_DEG * Math.cos((lat * Math.PI) / 180);
  const ky = KM_PER_DEG;
  let best = Infinity;
  for (const rings of polygons) {
    for (const ring of rings) {
      for (let i = 0; i + 3 < ring.length; i += 2) {
        const ax = (ring[i] - lng) * kx;
        const ay = (ring[i + 1] - lat) * ky;
        const bx = (ring[i + 2] - lng) * kx;
        const by = (ring[i + 3] - lat) * ky;
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
        const px = ax + t * dx;
        const py = ay + t * dy;
        best = Math.min(best, Math.hypot(px, py));
      }
    }
  }
  return best;
}

/**
 * `{ district, state }` for the point, or null when it is in no district —
 * outside India, or offshore. `district` alone can be null, for the few
 * polygons the source left unnamed; the state is still known.
 */
function districtAt(lat, lng) {
  const all = load();
  const margin = EDGE_TOLERANCE_KM / KM_PER_DEG / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  let inside = null;
  let nearest = null;
  for (const x of all) {
    const [minX, minY, maxX, maxY] = x.b;
    if (lng < minX - margin || lng > maxX + margin || lat < minY - margin || lat > maxY + margin) {
      continue;
    }
    if (lng >= minX && lng <= maxX && lat >= minY && lat <= maxY && contains(x.p, lng, lat)) {
      // The smallest wins when two claim the point: the source does not cut
      // enclaves out of the district around them — Yanam lies inside East
      // Godavari's outline as well as its own.
      const area = (maxX - minX) * (maxY - minY);
      if (!inside || area < inside.area) inside = { x, area };
      continue;
    }
    if (inside) continue;
    const km = kmToEdge(x.p, lng, lat);
    if (km <= EDGE_TOLERANCE_KM && (!nearest || km < nearest.km)) nearest = { x, km };
  }
  const hit = inside?.x ?? nearest?.x;
  return hit ? { district: hit.d, state: hit.s } : null;
}

module.exports = { districtAt };
