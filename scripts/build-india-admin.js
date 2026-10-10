'use strict';

/**
 * Builds `src/assets/geo/india-admin.json.gz` — every Indian district's
 * boundary, tagged with its state — from the geoBoundaries release files.
 *
 *   node scripts/build-india-admin.js <ADM1.geojson> <ADM2.geojson>
 *
 * Sources (geoBoundaries gbOpen, IND, simplified geometry, commit 9469f09):
 *   ADM2 districts — 2021, Pathways Data Pvt. Ltd. from lgdirectory.gov.in,
 *                    Open Data Commons ODbL 1.0
 *   ADM1 states    — DataMeet India community, Election Commission of India,
 *                    CC BY 2.5 IN
 * See `src/assets/geo/NOTICE.md` for the attribution both licences require.
 *
 * Run once, when the boundaries are updated; the output is committed and the
 * server only ever reads it. The state is decided here rather than per
 * request: a district belongs to one state, and asking the state polygons at
 * lookup time could answer with a neighbour for a point near a border.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const [adm1Path, adm2Path] = process.argv.slice(2);
if (!adm1Path || !adm2Path) {
  console.error('usage: node scripts/build-india-admin.js <ADM1.geojson> <ADM2.geojson>');
  process.exit(1);
}

const OUT = path.join(__dirname, '../src/assets/geo/india-admin.json.gz');

/** `Tamil Nādu` → `Tamil Nadu`; `Leh(Ladakh)` → `Leh (Ladakh)`. */
function cleanName(raw) {
  const special = { 'Warangal (R)': 'Warangal Rural', 'Warangal (U)': 'Warangal Urban' };
  if (special[raw]) return special[raw];
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s*\(\s*/g, ' (')
    .replace(/\s*\)/g, ')')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every polygon as a list of rings, each ring `[lng, lat, lng, lat, ...]`. */
function polygonsOf(geometry) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  // Five decimals is about a metre — finer than the simplified boundary.
  const r = (n) => Math.round(n * 1e5) / 1e5;
  return polys.map((rings) => rings.map((ring) => ring.flatMap(([lng, lat]) => [r(lng), r(lat)])));
}

function bboxOf(polygons) {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const rings of polygons) {
    const outer = rings[0];
    for (let i = 0; i < outer.length; i += 2) {
      minX = Math.min(minX, outer[i]);
      maxX = Math.max(maxX, outer[i]);
      minY = Math.min(minY, outer[i + 1]);
      maxY = Math.max(maxY, outer[i + 1]);
    }
  }
  return [minX, minY, maxX, maxY];
}

/** Even-odd ray cast over all rings, so holes are excluded. */
function contains(polygons, lng, lat) {
  for (const rings of polygons) {
    let inside = false;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
        const [xi, yi, xj, yj] = [ring[i], ring[i + 1], ring[j], ring[j + 1]];
        if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
          inside = !inside;
        }
      }
    }
    if (inside) return true;
  }
  return false;
}

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const states = read(adm1Path).features.map((f) => {
  const polygons = polygonsOf(f.geometry);
  return { name: cleanName(f.properties.shapeName), polygons, bbox: bboxOf(polygons) };
});

/**
 * The state the district lies in, by points *inside* it.
 *
 * Points on its own boundary are no use: along a border they sit exactly on
 * the line between two states, and the states' boundaries come from another
 * source, simplified differently — Puducherry's enclaves voted themselves
 * into Tamil Nadu that way. Instead a grid over the district's bounding box,
 * keeping only points inside the district, and the state most of them fall in.
 */
function stateFor(polygons) {
  const [minX, minY, maxX, maxY] = bboxOf(polygons);
  const votes = new Map();
  const N = 24;
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const lng = minX + ((maxX - minX) * i) / N;
      const lat = minY + ((maxY - minY) * j) / N;
      if (!contains(polygons, lng, lat)) continue;
      for (const s of states) {
        const [a, b, c, d] = s.bbox;
        if (lng < a || lng > c || lat < b || lat > d) continue;
        if (contains(s.polygons, lng, lat)) votes.set(s.name, (votes.get(s.name) ?? 0) + 1);
      }
    }
  }
  let best = null;
  for (const [name, n] of votes) if (!best || n > best[1]) best = [name, n];
  return best?.[0] ?? null;
}

/**
 * Districts whose state the boundaries cannot settle: Yanam is Puducherry's,
 * though it sits inside Andhra Pradesh; Lakshadweep's islands are too small
 * for the grid in [stateFor] to land on.
 */
const STATE_OF = { Yanam: 'Puducherry', Lakshadweep: 'Lakshadweep' };

/**
 * Current names for districts renamed since the source was drawn, and its
 * misspellings — same boundaries, so a name change is the whole correction.
 * Keyed by state as well, since several names recur across states
 * (Bijapur, Aurangabad).
 *
 * Splits cannot be fixed this way — a district carved out after 2021 has no
 * boundary here (most visibly Andhra Pradesh's 2022 reorganisation, 13
 * districts into 26). Those points still resolve, to the parent district.
 */
const RENAMED = {
  'Karnataka|Bangalore': 'Bengaluru Urban',
  'Karnataka|Bangalore Rural': 'Bengaluru Rural',
  'Karnataka|Belgaum': 'Belagavi',
  'Karnataka|Bellary': 'Ballari',
  'Karnataka|Bijapur': 'Vijayapura',
  'Karnataka|Chikmagalur': 'Chikkamagaluru',
  'Karnataka|Gulbarga': 'Kalaburagi',
  'Karnataka|Mysore': 'Mysuru',
  'Karnataka|Shimoga': 'Shivamogga',
  'Karnataka|Tumkur': 'Tumakuru',
  'Telangana|Hydrabad': 'Hyderabad',
  'Gujarat|Batod': 'Botad',
  'Gujarat|Ahmadabad': 'Ahmedabad',
  'Gujarat|Dohad': 'Dahod',
  'Haryana|Gurgaon': 'Gurugram',
  'Haryana|Mewat': 'Nuh',
  'Madhya Pradesh|Hoshangabad': 'Narmadapuram',
  'Maharashtra|Ahmadnagar': 'Ahilyanagar',
  'Maharashtra|Aurangabad': 'Chhatrapati Sambhajinagar',
  'Maharashtra|Osmanabad': 'Dharashiv',
  'Maharashtra|Bid': 'Beed',
  'Uttar Pradesh|Allahabad': 'Prayagraj',
  'Uttar Pradesh|Faizabad': 'Ayodhya',
  'Uttar Pradesh|Jyotiba Phule Nagar': 'Amroha',
  'Uttar Pradesh|Kanshiram Nagar': 'Kasganj',
  'Uttar Pradesh|Mahamaya Nagar': 'Hathras',
  'Uttar Pradesh|Samli': 'Shamli',
  'Uttar Pradesh|Sant Ravidas Nagar (Bhadohi)': 'Bhadohi',
  'Uttar Pradesh|Kheri': 'Lakhimpur Kheri',
  'Uttar Pradesh|Bara Banki': 'Barabanki',
  'Punjab|Muktsar': 'Sri Muktsar Sahib',
  'Tamil Nadu|Chengalputtu': 'Chengalpattu',
};

/** Polygons the source left unnamed — the state is known, the district not. */
const UNNAMED = new Set(['DATA NOT AVAILABLE']);

const districts = read(adm2Path).features.map((f) => {
  const polygons = polygonsOf(f.geometry);
  const raw = cleanName(f.properties.shapeName);
  const state = STATE_OF[raw] ?? stateFor(polygons);
  return {
    d: UNNAMED.has(raw) ? null : (RENAMED[`${state}|${raw}`] ?? raw),
    s: state,
    b: bboxOf(polygons),
    p: polygons,
  };
});

const unused = Object.keys(RENAMED).filter(
  (key) => !districts.some((x) => `${x.s}|${x.d}` === `${key.split('|')[0]}|${RENAMED[key]}`)
);
if (unused.length) console.warn('renames that matched nothing:', unused.join(', '));

const unassigned = districts.filter((x) => !x.s).map((x) => x.d);
if (unassigned.length) console.warn('no state found for:', unassigned.join(', '));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const json = JSON.stringify({ v: 1, districts });
fs.writeFileSync(OUT, zlib.gzipSync(json, { level: 9 }));
console.log(
  `${districts.length} districts, ${states.length} states → ${path.relative(process.cwd(), OUT)} ` +
    `(${(fs.statSync(OUT).size / 1024 / 1024).toFixed(1)} MB)`
);
