'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const env = require('../config/env');

/**
 * Where uploaded bytes go.
 *
 * Two drivers behind one interface:
 *
 *   `s3`    Any S3-compatible object store — Cloudflare R2, AWS S3, Backblaze
 *           B2, MinIO. The production driver. Survives redeploys, scales past
 *           one machine, and serves through a CDN.
 *   `local` Files under `backend/uploads`, served by Express. Development only,
 *           and refused at boot in production: a container filesystem is
 *           ephemeral, so every redeploy would silently delete every user's
 *           photo while the database kept pointing at them.
 *
 * The interface is deliberately narrow — `put` and `remove` — because that is
 * all a profile photo needs, and a wider one invites the storage layer to grow
 * business logic.
 */

// ── What we accept ──────────────────────────────────────────────────────────
//
// Checked by magic bytes rather than by the `Content-Type` header or the file
// extension. Both of those are supplied by the client and neither is evidence:
// a `.jpg` named file with a `image/jpeg` header can contain anything, and an
// object store will happily serve it back with whatever type it was told.

const SIGNATURES = [
  { ext: 'jpg', mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { ext: 'png', mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // WebP is a RIFF container: "RIFF" .... "WEBP". The size field sits between
  // the two, so the second marker is matched at its own offset.
  {
    ext: 'webp',
    mime: 'image/webp',
    bytes: [0x52, 0x49, 0x46, 0x46],
    also: { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
  },
];

function startsWith(buffer, bytes, offset = 0) {
  if (buffer.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buffer[offset + i] === b);
}

/**
 * The image type these bytes actually are, or null.
 *
 * HEIC is absent on purpose. iPhones shoot it by default and browsers cannot
 * display it, so accepting it would store photos that never render. The client
 * converts to JPEG before upload.
 */
function detectImage(buffer) {
  for (const sig of SIGNATURES) {
    if (!startsWith(buffer, sig.bytes)) continue;
    if (sig.also && !startsWith(buffer, sig.also.bytes, sig.also.offset)) continue;
    return { ext: sig.ext, mime: sig.mime };
  }
  return null;
}

// Audio, checked the same way and for the same reason — a client-supplied
// `Content-Type` is a claim, not evidence. WAV is what the app's recorder
// actually produces; AAC/M4A and MP3 are matched too in case that ever
// changes, since the container format is cheap to recognise either way.
const AUDIO_SIGNATURES = [
  // WAV: a RIFF container carrying a "WAVE" form type, the same pattern as
  // WebP's RIFF check above — the marker sits after the 4-byte size field.
  {
    ext: 'wav',
    mime: 'audio/wav',
    bytes: [0x52, 0x49, 0x46, 0x46],
    also: { offset: 8, bytes: [0x57, 0x41, 0x56, 0x45] },
  },
  // M4A/AAC (ISO base media): a 4-byte size field, then "ftyp" at offset 4 —
  // the size varies per file, so only the "ftyp" marker itself is matched.
  { ext: 'm4a', mime: 'audio/mp4', bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 },
  // MP3 with an ID3v2 tag at the start.
  { ext: 'mp3', mime: 'audio/mpeg', bytes: [0x49, 0x44, 0x33] },
  // MP3 with no tag: an MPEG audio frame sync straight away.
  { ext: 'mp3', mime: 'audio/mpeg', bytes: [0xff, 0xfb] },
];

/** The audio type these bytes actually are, or null. Same magic-byte approach as [detectImage]. */
function detectAudio(buffer) {
  for (const sig of AUDIO_SIGNATURES) {
    if (!startsWith(buffer, sig.bytes, sig.offset ?? 0)) continue;
    if (sig.also && !startsWith(buffer, sig.also.bytes, sig.also.offset)) continue;
    return { ext: sig.ext, mime: sig.mime };
  }
  return null;
}

// ── Keys ────────────────────────────────────────────────────────────────────

/**
 * Content-addressed: the key is the hash of the bytes.
 *
 * Re-uploading the same file is then idempotent rather than accumulating
 * near-duplicate objects, and the key cannot be guessed from a user id — an
 * object store bucket is usually public, so a predictable key would let anyone
 * enumerate every user's photo or clip.
 */
function keyFor(userId, buffer, ext, namespace) {
  const digest = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32);
  return `${namespace}/${userId}/${digest}.${ext}`;
}

// ── S3-compatible driver ────────────────────────────────────────────────────

let s3Client = null;

function client() {
  if (s3Client) return s3Client;
  // Required lazily so a development machine with no storage configured does
  // not pay the SDK's load time on every boot.
  const { S3Client } = require('@aws-sdk/client-s3');
  s3Client = new S3Client({
    region: env.storage.region,
    // R2, MinIO and B2 all need an explicit endpoint; real AWS S3 does not,
    // and passing undefined lets the SDK derive it from the region.
    endpoint: env.storage.endpoint || undefined,
    credentials: {
      accessKeyId: env.storage.accessKeyId,
      secretAccessKey: env.storage.secretAccessKey,
    },
    // R2 rejects the virtual-host style bucket addressing the SDK prefers.
    forcePathStyle: env.storage.forcePathStyle,
  });
  return s3Client;
}

async function s3Put(key, buffer, mime) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await client().send(
    new PutObjectCommand({
      Bucket: env.storage.bucket,
      Key: key,
      Body: buffer,
      ContentType: mime,
      // A year, because the key is a content hash: these bytes can never
      // change under this key, so there is nothing to revalidate.
      CacheControl: 'public, max-age=31536000, immutable',
    })
  );
}

async function s3Remove(key) {
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  await client().send(
    new DeleteObjectCommand({ Bucket: env.storage.bucket, Key: key })
  );
}

// ── Local driver ────────────────────────────────────────────────────────────

const LOCAL_ROOT = path.resolve(__dirname, '../../uploads');

async function localPut(key, buffer) {
  const target = path.join(LOCAL_ROOT, key);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, buffer);
}

async function localRemove(key) {
  const target = path.join(LOCAL_ROOT, key);
  // Missing is the desired end state, not an error.
  await fsp.rm(target, { force: true });
}

// ── The interface ───────────────────────────────────────────────────────────

/**
 * Stores an image and returns the URL it will be served from.
 *
 * Throws `StorageError` with a `code` the controller maps to a status: the
 * caller sending a 20 MB video is a 400, the bucket being unreachable is a 502,
 * and confusing the two makes the app retry something that will never work.
 */
async function putAvatar(userId, buffer) {
  if (!env.storage.configured) {
    throw new StorageError('Photo storage is not configured on this server.', 'not_configured');
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new StorageError('The upload was empty.', 'invalid');
  }
  if (buffer.length > env.storage.maxBytes) {
    throw new StorageError(
      `Images must be under ${Math.floor(env.storage.maxBytes / 1024 / 1024)} MB.`,
      'too_large'
    );
  }

  const kind = detectImage(buffer);
  if (!kind) {
    throw new StorageError('That file is not a JPEG, PNG or WebP image.', 'invalid');
  }

  const key = keyFor(userId, buffer, kind.ext, 'avatars');

  try {
    if (env.storage.driver === 's3') {
      await s3Put(key, buffer, kind.mime);
    } else {
      await localPut(key, buffer);
    }
  } catch (error) {
    throw new StorageError(`Could not store the image: ${error.message}`, 'unavailable');
  }

  return { key, url: urlFor(key), bytes: buffer.length, mime: kind.mime };
}

/**
 * Stores a verification clip and returns the URL it will be served from.
 *
 * Same shape as [putAvatar] — content-addressed key, magic-byte type check,
 * its own size ceiling — kept as a separate function rather than a shared one
 * with a `namespace` parameter threaded through, because the two are likely to
 * diverge (a retention policy on verification clips that avatars don't need,
 * for one) and a shared function would have to grow a branch for that anyway.
 */
async function putVerification(userId, buffer) {
  if (!env.storage.configured) {
    throw new StorageError('Recording storage is not configured on this server.', 'not_configured');
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new StorageError('The upload was empty.', 'invalid');
  }
  if (buffer.length > env.storage.verificationMaxBytes) {
    throw new StorageError(
      `Recordings must be under ${Math.floor(env.storage.verificationMaxBytes / 1024 / 1024)} MB.`,
      'too_large'
    );
  }

  const kind = detectAudio(buffer);
  if (!kind) {
    throw new StorageError('That file is not a recognised audio recording.', 'invalid');
  }

  const key = keyFor(userId, buffer, kind.ext, 'verifications');

  try {
    if (env.storage.driver === 's3') {
      await s3Put(key, buffer, kind.mime);
    } else {
      await localPut(key, buffer);
    }
  } catch (error) {
    throw new StorageError(`Could not store the recording: ${error.message}`, 'unavailable');
  }

  return { key, url: urlFor(key), bytes: buffer.length, mime: kind.mime };
}

/**
 * Deletes a previously stored object, by URL.
 *
 * By URL rather than by key because the URL is what the database holds — the
 * key is an implementation detail of this file. A URL this server did not issue
 * is ignored rather than rejected: profiles seeded or edited before storage
 * existed carry arbitrary URLs, and failing to delete one must not block the
 * user from replacing their photo.
 */
async function removeAvatar(url) {
  return removeObject(url, 'avatars');
}

/** Same as [removeAvatar], for a stored verification recording. */
async function removeVerification(url) {
  return removeObject(url, 'verifications');
}

async function removeObject(url, namespace) {
  const key = keyFromUrl(url, namespace);
  if (!key) return false;
  try {
    if (env.storage.driver === 's3') {
      await s3Remove(key);
    } else {
      await localRemove(key);
    }
    return true;
  } catch {
    // A leaked object costs a fraction of a cent. Failing the user's request
    // over it costs them their new photo.
    return false;
  }
}

function urlFor(key) {
  return `${env.storage.publicUrl.replace(/\/+$/, '')}/${key}`;
}

function keyFromUrl(url, namespace = 'avatars') {
  if (typeof url !== 'string' || !url) return null;
  const base = `${env.storage.publicUrl.replace(/\/+$/, '')}/`;
  if (!url.startsWith(base)) return null;
  const key = url.slice(base.length);
  // Only ever delete inside the namespace asked for, and never let a
  // traversal segment out of it.
  if (!key.startsWith(`${namespace}/`) || key.includes('..')) return null;
  return key;
}

class StorageError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}

/** Express static options for the local driver. Unused when `s3` is active. */
function localStaticRoot() {
  if (!fs.existsSync(LOCAL_ROOT)) fs.mkdirSync(LOCAL_ROOT, { recursive: true });
  return LOCAL_ROOT;
}

module.exports = {
  putAvatar,
  removeAvatar,
  putVerification,
  removeVerification,
  detectImage,
  detectAudio,
  keyFromUrl,
  localStaticRoot,
  StorageError,
  LOCAL_ROOT,
};
