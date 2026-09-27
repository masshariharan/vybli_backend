'use strict';

const crypto = require('node:crypto');

/**
 * A delivery receipt: proof, carried inside a push, that *this* push reached
 * *this* recipient — so the phone can report the second tick without signing
 * in.
 *
 * Why not just the access token. The ack is sent from FCM's background
 * isolate, with the app in the background or killed. Access tokens last
 * fifteen minutes, so for anyone who put their phone down longer than that
 * the ack met a 401 and had to refresh first — and a refresh **rotates** the
 * session. The app still sitting in memory kept the old pair, and the next
 * time it was opened its refresh was refused as a replayed token: the second
 * tick either never arrived or cost the recipient their sign-in. A receipt
 * needs no session at all, so there is nothing to expire and nothing to
 * rotate.
 *
 * What it allows is deliberately tiny: moving one message the holder
 * *received* from `sent` to `delivered`. It is an HMAC over the recipient and
 * the message, keyed off the server's JWT secret under its own label, so it
 * cannot be forged, cannot be replayed onto another message, and does not
 * double as any kind of credential.
 */

function key(secret) {
  return crypto.createHash('sha256').update(`vybli.delivery-receipt:${secret}`).digest();
}

function sign(recipientId, messageId, secret = require('../config/env').jwt.secret) {
  return crypto
    .createHmac('sha256', key(secret))
    .update(`${recipientId}.${messageId}`)
    .digest('base64url');
}

/** Constant-time: a receipt must not be guessable a byte at a time. */
function verify(recipientId, messageId, receipt, secret) {
  if (typeof receipt !== 'string' || !recipientId || !messageId) return false;
  const expected = Buffer.from(sign(recipientId, messageId, secret));
  const given = Buffer.from(receipt);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

module.exports = { sign, verify };
