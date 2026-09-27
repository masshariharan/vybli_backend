'use strict';

const { errors } = require('./errors');

/**
 * The end-to-end encrypted message envelope — its format, and the only
 * checks a server can make about one.
 *
 * **The server cannot read a message and is not meant to.** Encryption and
 * decryption happen on the phones (`lib/data/remote/e2ee/` in the app); what
 * reaches here is ciphertext plus the wrapped keys that let each intended
 * device open it. This file checks the envelope is well-formed and not
 * absurdly large, and that is all it can check. Whether it decrypts, and to
 * what, is known only to the devices it was written for.
 *
 * ## Format, version 1
 *
 *     {
 *       v: 1,
 *       sender_device: "<the sending device's id>",
 *       epk: b64(32),               // ephemeral X25519 public key, per message
 *       iv:  b64(12),               // AES-GCM nonce for `ct`
 *       ct:  b64(…),                // AES-256-GCM(CEK, payload), tag appended
 *       keys: [                     // one per device that may read it
 *         { user: "<user id>", device: "<device id>", iv: b64(12), wk: b64(48) }
 *       ]
 *     }
 *
 * A fresh random 256-bit content key (CEK) seals the payload — the JSON
 * `{ t: text, a: attachment? }`, padded with trailing spaces to a multiple of
 * 64 bytes so a ciphertext's length says little about the message's. The CEK
 * is then wrapped once per reading device, HPKE-style in auth mode:
 *
 *     dh   = X25519(eph, R) ‖ X25519(S, R)
 *     KEK  = HKDF-SHA256(dh, salt = epk ‖ R ‖ S,
 *                        info = "vybli-e2ee/v1/wrap|<user>|<device>")
 *     wk   = AES-256-GCM(KEK, iv, CEK, aad)
 *
 * where `R` is the reading device's public key and `S` the sending device's.
 * The second DH is what authenticates the sender: only the holder of `S`'s
 * private key (or of `R`'s) could have derived that KEK, so a message that
 * unwraps came from the device it names. The server cannot forge one, even
 * though it knows every public key.
 *
 * Both AES-GCM operations take the same associated data,
 * `"vybli-e2ee/v1|<conversation id>|<sender user id>|<sender device>|<epk>"`,
 * so an envelope moved to another conversation or credited to another sender
 * fails to decrypt rather than appearing there.
 *
 * The sender's *own* devices are among the readers — this one included — so
 * history stays readable on every phone the sender is signed in on, and the
 * sending phone can re-read its own messages after a restart.
 *
 * What this does not give, stated so nobody assumes it: forward secrecy
 * against the later theft of a device's private key (that needs a ratchet,
 * and a ratchet needs messages kept on the phone rather than re-read from
 * here), and protection against a server that substitutes keys in the
 * directory for a user whose phone has never seen the real ones. The app pins
 * the keys it has seen and says so when they change; that is the defence.
 */

const VERSION = 1;

/** A device id as a phone generates it: url-safe, bounded. */
const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/;
/** A user id — a cuid, in practice, but not assumed to be. */
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** The most devices one message is encrypted for — both people, all phones. */
const MAX_RECIPIENT_DEVICES = 32;
/**
 * The largest `ct`, in base64 characters. The payload is at most a 4000-char
 * message (≤16 kB of UTF-8) and one attachment's display fields; 64 kB of
 * base64 is that with room to spare and still nothing a database minds.
 */
const MAX_CIPHERTEXT_CHARS = 64 * 1024;

function decodedLength(value) {
  if (typeof value !== 'string' || !BASE64.test(value) || value.length % 4 !== 0) {
    return -1;
  }
  return Buffer.from(value, 'base64').length;
}

function fail(why) {
  return errors.badRequest(`That encrypted message is malformed: ${why}.`);
}

function exactly(value, bytes, name) {
  if (decodedLength(value) !== bytes) throw fail(`${name} must be ${bytes} bytes`);
}

/**
 * Checks [raw] is a well-formed version-1 envelope and returns a clean copy
 * holding only the known fields — nothing a client adds rides along into
 * the database.
 */
function parseEnvelope(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail('not an object');
  if (raw.v !== VERSION) throw fail(`unsupported version ${raw.v}`);
  if (typeof raw.sender_device !== 'string' || !DEVICE_ID.test(raw.sender_device)) {
    throw fail('bad sender_device');
  }
  exactly(raw.epk, 32, 'epk');
  exactly(raw.iv, 12, 'iv');
  const ctLength = decodedLength(raw.ct);
  // At least the 16-byte GCM tag plus one padded block.
  if (ctLength < 16 + 64 || raw.ct.length > MAX_CIPHERTEXT_CHARS) {
    throw fail('ct is out of range');
  }
  if (!Array.isArray(raw.keys) || raw.keys.length === 0) throw fail('no keys');
  if (raw.keys.length > MAX_RECIPIENT_DEVICES) throw fail('too many keys');

  const seen = new Set();
  const keys = raw.keys.map((k) => {
    if (!k || typeof k !== 'object') throw fail('bad key entry');
    if (typeof k.user !== 'string' || !USER_ID.test(k.user)) throw fail('bad key user');
    if (typeof k.device !== 'string' || !DEVICE_ID.test(k.device)) {
      throw fail('bad key device');
    }
    exactly(k.iv, 12, 'key iv');
    exactly(k.wk, 48, 'wk');
    const id = `${k.user}/${k.device}`;
    if (seen.has(id)) throw fail('duplicate key entry');
    seen.add(id);
    return { user: k.user, device: k.device, iv: k.iv, wk: k.wk };
  });

  return {
    v: VERSION,
    sender_device: raw.sender_device,
    epk: raw.epk,
    iv: raw.iv,
    ct: raw.ct,
    keys,
  };
}

/** Whether [value] is a base64 X25519 public key. */
function isPublicKey(value) {
  return decodedLength(value) === 32;
}

module.exports = {
  VERSION,
  DEVICE_ID,
  MAX_RECIPIENT_DEVICES,
  parseEnvelope,
  isPublicKey,
};
