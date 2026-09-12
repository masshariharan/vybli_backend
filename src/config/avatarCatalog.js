'use strict';

const fs = require('fs');
const path = require('path');

/**
 * The predefined avatars every account picks from.
 *
 * There is no per-user file, ever — an account's `UserProfile.avatarId`
 * names one of these, and this catalog is the only place that turns an id
 * into a URL. Picking an avatar is then a single small write (an id string)
 * instead of a file upload, and a thousand accounts choosing the same face
 * cost one file on disk, not a thousand copies of it.
 *
 * Built from the files actually on disk under `assets/avatars/<gender>/`
 * rather than a hand-maintained list, so adding or removing an image here
 * is the only step — nothing to keep in sync by hand, and nothing can name
 * an avatar that does not exist.
 *
 * The id is the filename without its extension. These already came off
 * disk with clean, stable, unique names (`male_01`, `female_03`, …), so
 * there is no separate id to invent or a mapping table to maintain.
 */

const ROOT = path.join(__dirname, '../assets/avatars');
const GENDERS = ['male', 'female'];
const EXTENSIONS = /\.(jpe?g|png|webp)$/i;

function build() {
  const entries = [];
  for (const gender of GENDERS) {
    const dir = path.join(ROOT, gender);
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      files = [];
    }
    for (const file of files.filter((f) => EXTENSIONS.test(f)).sort()) {
      const id = path.parse(file).name;
      entries.push({ id, gender, file, url: `/avatars/${gender}/${file}` });
    }
  }
  return entries;
}

// Read once at boot. The catalog is bundled with the code — it only ever
// changes on a deploy, which restarts the process anyway.
const CATALOG = build();
const BY_ID = new Map(CATALOG.map((avatar) => [avatar.id, avatar]));

/** Every avatar, or just one gender's — the picker asks for its own. */
function list(gender) {
  return gender ? CATALOG.filter((avatar) => avatar.gender === gender) : CATALOG;
}

function get(id) {
  if (!id) return null;
  return BY_ID.get(id) ?? null;
}

function isValid(id) {
  return BY_ID.has(id);
}

/** Null for a missing or unrecognised id — never throws. Read paths render
 *  whatever is actually stored, including a stale or invalid value. */
function urlFor(id) {
  return get(id)?.url ?? null;
}

/** The first avatar for a gender — what a fresh account starts on. */
function defaultFor(gender) {
  return list(gender)[0]?.id ?? null;
}

module.exports = { list, get, isValid, urlFor, defaultFor, ROOT };
