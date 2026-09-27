'use strict';

const crypto = require('node:crypto');
const env = require('../config/env');

/**
 * Encryption at rest for the few columns the server has to be able to read
 * but a database leak should not hand over — a payout UPI ID, today.
 *
 * Not end-to-end, and not meant to be: the platform pays money *to* this ID,
 * so it must be able to read it. What this protects against is the database
 * on its own getting out — a stolen backup, a leaked read replica, a
 * misconfigured admin tool — without the key, which lives in the process's
 * environment (`DATA_ENCRYPTION_KEY`), never beside the data.
 *
 * AES-256-GCM, stored as `enc:v1:<base64 iv‖ciphertext‖tag>`. Values without
 * the prefix are read as plaintext, so rows written before the key was set
 * keep working, and are encrypted the next time they are written.
 */

const PREFIX = 'enc:v1:';

function key() {
  return env.dataEncryptionKey;
}

/** Encrypts [value] for storage — or returns it unchanged with no key set. */
function seal(value) {
  if (value == null || !key()) return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64');
}

/**
 * Reads a stored value. Null for one that cannot be decrypted — the key was
 * rotated away or is missing — rather than handing ciphertext on as if it
 * were an ID someone could be paid at.
 */
function open(value) {
  if (value == null || !String(value).startsWith(PREFIX)) return value;
  if (!key()) {
    console.error('[crypto] an encrypted value was read with DATA_ENCRYPTION_KEY unset');
    return null;
  }
  try {
    const raw = Buffer.from(String(value).slice(PREFIX.length), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([
      decipher.update(raw.subarray(12, raw.length - 16)),
      decipher.final(),
    ]).toString('utf8');
  } catch (err) {
    console.error('[crypto] a stored value could not be decrypted:', err.message);
    return null;
  }
}

/**
 * A UPI ID as it may appear somewhere less guarded than the wallet itself — a
 * transaction line, a notification: `ra•••@okaxis`. Enough to recognise, not
 * enough to reuse.
 */
function maskUpi(upiId) {
  if (!upiId) return upiId;
  const [name, bank] = String(upiId).split('@');
  const shown = name.slice(0, Math.min(2, Math.max(0, name.length - 2)));
  return `${shown}•••${bank ? `@${bank}` : ''}`;
}

module.exports = { seal, open, maskUpi };
