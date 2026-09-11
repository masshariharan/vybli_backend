'use strict';

const admin = require('firebase-admin');
const { parsePhoneNumberFromString } = require('libphonenumber-js');

const env = require('../config/env');
const { errors } = require('../utils/errors');

/**
 * Firebase, used as a phone-verification oracle and nothing else.
 *
 * This is the whole design decision, and it is worth being explicit about:
 * Firebase tells us **"this person controls this phone number"**. That is all
 * we take from it. The Vybli account, its id, its session, its wallet and
 * every foreign key in the database remain ours.
 *
 * The alternative — letting the Firebase UID be the user identity — is the
 * trap. It looks simpler on day one and it welds the product to Google
 * permanently: migrating off would mean rewriting identity across the API, the
 * app and the admin panel. Verifying a token and then minting our own session
 * costs one function and keeps the exit open.
 *
 * Firebase replaces `otp.service`. It does not replace `auth.service`.
 */

let app = null;

/**
 * The Admin SDK, built on first use.
 *
 * Two modes, and the difference is deliberate:
 *
 *  * **Project id only** — the normal case here. Verifying an ID token means
 *    checking a signature against Google's *public* certificates and then
 *    checking the claims. No credential is involved, so there is no private
 *    key to store, leak or rotate. A service account is only needed for
 *    privileged calls — minting custom tokens, disabling users, reading a
 *    user record — and this server makes none of them.
 *  * **With a service account** — additionally unlocks the revocation check
 *    in [verifyPhoneToken]. Optional, and only worth the key management if
 *    you also intend to disable Firebase users from somewhere.
 *
 * Lazy either way, because a development machine with neither must still boot
 * and run the OTP path and the whole test suite.
 */
function client() {
  if (!env.firebase.configured) return null;
  if (!app) {
    app = admin.initializeApp(
      env.firebase.hasServiceAccount
        ? {
            projectId: env.firebase.projectId,
            credential: admin.credential.cert({
              projectId: env.firebase.projectId,
              clientEmail: env.firebase.clientEmail,
              // Service-account keys carry literal "\n" when they travel
              // through an environment variable. Left unconverted the PEM is
              // malformed and the SDK fails with an opaque crypto error.
              privateKey: env.firebase.privateKey.replace(/\\n/g, '\n'),
            }),
          }
        : { projectId: env.firebase.projectId }
    );
  }
  return app;
}

/**
 * Checks a Firebase ID token and returns the verified phone number.
 *
 * Two guards beyond the signature:
 *
 *  * **Revocation**, when a service account is configured. Without one this
 *    cannot be asked, because it reads the Firebase user record.
 *  * **Freshness**, always. A Firebase ID token lives an hour, and this
 *    endpoint creates accounts — a token replayed forty minutes after it was
 *    minted is not somebody signing in. Rejecting stale ones closes that
 *    window whether or not revocation is available, and matters more here
 *    than revocation does: the token is used once, seconds after issue.
 */
async function verifyPhoneToken(idToken) {
  if (!env.firebase.configured) {
    throw errors.internal('Firebase sign-in is not configured on this server.');
  }
  if (!idToken || typeof idToken !== 'string') {
    throw errors.badRequest('Missing Firebase token.');
  }

  let decoded;
  try {
    decoded = await admin
      .auth(client())
      .verifyIdToken(idToken, env.firebase.hasServiceAccount);
  } catch (err) {
    // Expired, revoked, wrong project, or forged. None of them is something
    // the user can act on beyond trying again, and naming which would tell a
    // prober how close they got.
    console.warn('[firebase] token rejected:', err.code || err.message);
    throw errors.invalidToken('That sign-in could not be verified. Please try again.');
  }

  // How long ago the user actually proved they hold the number, not when the
  // token was minted — `iat` refreshes silently, `auth_time` does not.
  const authAge = Math.floor(Date.now() / 1000) - (decoded.auth_time ?? decoded.iat ?? 0);
  if (authAge > env.firebase.maxAuthAgeSeconds) {
    throw errors.invalidToken('That sign-in has expired. Please start again.');
  }

  const raw = decoded.phone_number;
  if (!raw) {
    // A Google or email sign-in reaching this endpoint. The whole product is
    // keyed on a phone number, so a token without one is not usable here.
    throw errors.badRequest('That sign-in did not include a phone number.');
  }

  const parsed = splitE164(raw);
  return { ...parsed, firebaseUid: decoded.uid, e164: raw };
}

/**
 * `+919876543210` → `{ dialCode: '+91', phone: '9876543210' }`.
 *
 * Split with libphonenumber rather than by string length. Country codes are
 * one to three digits and national number lengths vary, so any hand-rolled
 * rule is wrong for some country — and a wrong split silently creates a
 * second account for the same person.
 */
function splitE164(e164) {
  const parsed = parsePhoneNumberFromString(e164);
  if (!parsed || !parsed.isValid()) {
    throw errors.badRequest('That phone number is not valid.');
  }
  return {
    dialCode: `+${parsed.countryCallingCode}`,
    phone: parsed.nationalNumber,
    country: parsed.country ?? null,
  };
}

/**
 * Normalises a number the client typed, for the OTP path.
 *
 * The same split, so a user who signs in with Firebase today and OTP tomorrow
 * lands on the same account rather than a duplicate.
 */
function normalise({ dialCode, phone }) {
  const joined = `${dialCode}${phone}`.replace(/\s+/g, '');
  const parsed = parsePhoneNumberFromString(joined.startsWith('+') ? joined : `+${joined}`);
  if (!parsed || !parsed.isValid()) {
    throw errors.badRequest('That phone number is not valid.');
  }
  return {
    dialCode: `+${parsed.countryCallingCode}`,
    phone: parsed.nationalNumber,
  };
}

module.exports = {
  verifyPhoneToken,
  splitE164,
  normalise,
  get configured() {
    return env.firebase.configured;
  },
};
