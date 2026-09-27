'use strict';

/**
 * A reference implementation of the v1 message envelope (`src/utils/e2ee.js`
 * has the format), in Node's own crypto.
 *
 * **Tests only.** The server never encrypts or decrypts anything — that is
 * the whole design. This exists so the test suite can be a real client: send
 * messages only the other test account can open, and prove that what the
 * server stores and relays is ciphertext it could not have produced or read.
 * It is also the second, independent implementation the app's Dart one is
 * checked against (`test/e2ee_crypto_test.dart` decrypts a vector made here).
 */

const crypto = require('node:crypto');

const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');

const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64');

function publicKeyFromRaw(raw) {
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: 'der', type: 'spki' });
}

function privateKeyFromRaw(raw) {
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: 'der', type: 'pkcs8' });
}

function rawPublic(keyObject) {
  return keyObject.export({ format: 'der', type: 'spki' }).subarray(-32);
}

function rawPrivate(keyObject) {
  return keyObject.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
}

/** A device identity: `{ deviceId, privateKey (raw 32), publicKey (raw 32) }`. */
function newDevice(deviceId = `dev_${crypto.randomBytes(9).toString('base64url')}`, seed) {
  const privateKey = seed ? privateKeyFromRaw(seed) : crypto.generateKeyPairSync('x25519').privateKey;
  return {
    deviceId,
    privateKey: rawPrivate(privateKey),
    publicKey: rawPublic(crypto.createPublicKey(privateKey)),
  };
}

function dh(privateRaw, publicRaw) {
  return crypto.diffieHellman({
    privateKey: privateKeyFromRaw(privateRaw),
    publicKey: publicKeyFromRaw(publicRaw),
  });
}

function aadFor({ conversationId, senderUserId, senderDeviceId, epk }) {
  return Buffer.from(`vybli-e2ee/v1|${conversationId}|${senderUserId}|${senderDeviceId}|${epk}`, 'utf8');
}

function kek({ dh1, dh2, epk, recipientPublic, senderPublic, userId, deviceId }) {
  return Buffer.from(
    crypto.hkdfSync(
      'sha256',
      Buffer.concat([dh1, dh2]),
      Buffer.concat([epk, recipientPublic, senderPublic]),
      Buffer.from(`vybli-e2ee/v1/wrap|${userId}|${deviceId}`, 'utf8'),
      32
    )
  );
}

function seal(key, iv, plaintext, aad) {
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function open(key, iv, sealed, aad) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
}

/** `{ t, a? }` as UTF-8, space-padded to a multiple of 64 bytes. */
function encodePayload({ text, attachment }) {
  const json = Buffer.from(JSON.stringify(attachment ? { t: text, a: attachment } : { t: text }), 'utf8');
  const padded = Math.ceil((json.length + 1) / 64) * 64;
  return Buffer.concat([json, Buffer.alloc(padded - json.length, 0x20)]);
}

/**
 * Encrypts `{ text, attachment }` from `sender` (a device plus its user id)
 * for every entry of `recipients` — `[{ userId, deviceId, publicKey }]`.
 *
 * `fixed` pins the otherwise random values, for a reproducible test vector.
 */
function encrypt({ conversationId, senderUserId, sender, recipients, text, attachment, fixed = {} }) {
  const ephemeral = newDevice('ephemeral', fixed.ephemeralSeed);
  const epk = ephemeral.publicKey;
  const cek = fixed.cek ?? crypto.randomBytes(32);
  const iv = fixed.iv ?? crypto.randomBytes(12);
  const aad = aadFor({ conversationId, senderUserId, senderDeviceId: sender.deviceId, epk: b64(epk) });

  const keys = recipients.map((r, i) => {
    const recipientPublic = Buffer.from(r.publicKey);
    const key = kek({
      dh1: dh(ephemeral.privateKey, recipientPublic),
      dh2: dh(sender.privateKey, recipientPublic),
      epk,
      recipientPublic,
      senderPublic: sender.publicKey,
      userId: r.userId,
      deviceId: r.deviceId,
    });
    const keyIv = fixed.keyIvs?.[i] ?? crypto.randomBytes(12);
    return { user: r.userId, device: r.deviceId, iv: b64(keyIv), wk: b64(seal(key, keyIv, cek, aad)) };
  });

  return {
    v: 1,
    sender_device: sender.deviceId,
    epk: b64(epk),
    iv: b64(iv),
    ct: b64(seal(cek, iv, encodePayload({ text, attachment }), aad)),
    keys,
  };
}

/**
 * Opens an envelope as `reader` (`{ userId, device }`), given the sending
 * device's public key. Throws if it was not encrypted for this reader, was
 * tampered with, or was not written by the device it names.
 */
function decrypt({ envelope, conversationId, senderUserId, senderPublicKey, reader }) {
  const entry = envelope.keys.find(
    (k) => k.user === reader.userId && k.device === reader.device.deviceId
  );
  if (!entry) throw new Error('not encrypted for this device');
  const epk = unb64(envelope.epk);
  const aad = aadFor({
    conversationId,
    senderUserId,
    senderDeviceId: envelope.sender_device,
    epk: envelope.epk,
  });
  const key = kek({
    dh1: dh(reader.device.privateKey, epk),
    dh2: dh(reader.device.privateKey, Buffer.from(senderPublicKey)),
    epk,
    recipientPublic: reader.device.publicKey,
    senderPublic: Buffer.from(senderPublicKey),
    userId: reader.userId,
    deviceId: reader.device.deviceId,
  });
  const cek = open(key, unb64(entry.iv), unb64(entry.wk), aad);
  const payload = JSON.parse(open(cek, unb64(envelope.iv), unb64(envelope.ct), aad).toString('utf8'));
  return { text: payload.t, attachment: payload.a ?? null };
}

module.exports = { newDevice, encrypt, decrypt, b64, unb64 };
