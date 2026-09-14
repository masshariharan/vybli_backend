'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { errors } = require('./errors');

/**
 * Access and refresh tokens.
 *
 * The access token is short-lived and stateless — it is never checked against
 * the database on the hot path, which is the point of it. The refresh token is
 * long-lived and therefore *is* stateful: only its SHA-256 lives in
 * `user_sessions`, so a leaked database cannot be used to mint sessions, and a
 * single logout can revoke one device.
 *
 * The two are signed with different secrets. That is what stops a refresh
 * token — which the client holds for a month — from being replayed as an
 * access token.
 */

const ACCESS_AUDIENCE = 'vybli:access';
const REFRESH_AUDIENCE = 'vybli:refresh';

/**
 * [sessionId] is what ties this token to one sign-in.
 *
 * The access token is still verified by signature alone — no database read is
 * added to the hot path — but carrying the session id means the request
 * middleware can tell *which* sign-in a token came from, and refuse it once
 * that sign-in is over. Without it a revoked session's token stayed good until
 * it expired, so signing in on a new phone left the old one working for
 * another fifteen minutes.
 */
function signAccessToken(user, sessionId) {
  return jwt.sign(
    { sub: user.id, sid: sessionId, typ: 'access' },
    env.jwt.secret,
    { expiresIn: env.jwt.expiresIn, audience: ACCESS_AUDIENCE, issuer: 'vybli' }
  );
}

function signRefreshToken(user, sessionId) {
  return jwt.sign(
    { sub: user.id, sid: sessionId, typ: 'refresh' },
    env.jwt.refreshSecret,
    {
      expiresIn: env.jwt.refreshExpiresIn,
      audience: REFRESH_AUDIENCE,
      issuer: 'vybli',
    }
  );
}

function verifyAccessToken(token) {
  try {
    return jwt.verify(token, env.jwt.secret, {
      audience: ACCESS_AUDIENCE,
      issuer: 'vybli',
    });
  } catch (err) {
    // An expired token is worth distinguishing: the client should silently
    // refresh rather than bounce the user to the login screen.
    if (err.name === 'TokenExpiredError') {
      throw errors.invalidToken('Your session has expired.');
    }
    throw errors.invalidToken('That session is not valid.');
  }
}

function verifyRefreshToken(token) {
  try {
    return jwt.verify(token, env.jwt.refreshSecret, {
      audience: REFRESH_AUDIENCE,
      issuer: 'vybli',
    });
  } catch {
    throw errors.invalidToken('Please sign in again.');
  }
}

/** Refresh tokens are stored as digests, never in the clear. */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Milliseconds a refresh token is good for, for the session's `expiresAt`. */
function refreshTokenTtlMs() {
  const spec = env.jwt.refreshExpiresIn;
  const match = /^(\d+)([smhd])$/.exec(spec);
  if (!match) return 30 * 24 * 60 * 60 * 1000;
  const [, amount, unit] = match;
  const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return Number(amount) * unitMs;
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  hashToken,
  refreshTokenTtlMs,
};
