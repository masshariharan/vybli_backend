'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const env = require('../../config/env');
const { errors } = require('../../utils/errors');

/**
 * The single administrator.
 *
 * One credential, from the environment, compared here. No admin table, no
 * registration, no roles — the platform has exactly one operator, and a users
 * table plus a roles table plus a permissions matrix would be three tables of
 * ceremony wrapped around a single comparison.
 *
 * What that simplification does **not** excuse:
 *
 *  * the password living anywhere the frontend can see it,
 *  * a timing side-channel that tells an attacker when the username is right,
 *  * unlimited guesses.
 *
 * All three are handled below.
 */

/** issuer/audience, so a user token can never be replayed as an admin one. */
const ISSUER = 'vybli';
const AUDIENCE = 'vybli:admin';

/** The one identity. A constant, because there is exactly one of them. */
const ADMIN_SUBJECT = 'admin';

/**
 * Failed attempts, per source address.
 *
 * In-process, like the call-billing timers, and for the same reason: it is a
 * counter with a fifteen-minute memory, not a fact worth a table. A restart
 * clears it, which costs an attacker one restart they cannot trigger.
 *
 * A multi-instance deployment should move this behind Redis, or the lockout
 * only applies to whichever instance took the guesses.
 */
const attempts = new Map();

function attemptKey(ip) {
  return ip || 'unknown';
}

/** Whether this address is currently locked out, and for how much longer. */
function lockoutState(ip) {
  const entry = attempts.get(attemptKey(ip));
  if (!entry) return { locked: false, remaining: 0, failures: 0 };

  if (entry.lockedUntil && entry.lockedUntil > Date.now()) {
    return {
      locked: true,
      remaining: Math.ceil((entry.lockedUntil - Date.now()) / 1000),
      failures: entry.failures,
    };
  }

  // The lockout expired. Start again rather than leaving a stale count that
  // would lock the next single mistake out immediately.
  if (entry.lockedUntil) attempts.delete(attemptKey(ip));
  return { locked: false, remaining: 0, failures: entry.failures };
}

function recordFailure(ip) {
  const key = attemptKey(ip);
  const entry = attempts.get(key) ?? { failures: 0, lockedUntil: null };
  entry.failures += 1;
  if (entry.failures >= env.admin.maxFailedLogins) {
    entry.lockedUntil = Date.now() + env.admin.lockoutMinutes * 60_000;
  }
  attempts.set(key, entry);
  return entry;
}

function clearFailures(ip) {
  attempts.delete(attemptKey(ip));
}

/**
 * Compares the supplied password against the configured one.
 *
 * Prefers `ADMIN_PASSWORD_HASH` (bcrypt) and falls back to a **constant-time**
 * comparison of the plaintext. `===` on a secret leaks its length and its
 * matching prefix through timing; over enough attempts that is a password.
 */
async function passwordMatches(supplied) {
  if (env.admin.passwordHash) {
    return bcrypt.compare(supplied, env.admin.passwordHash);
  }

  const a = Buffer.from(String(supplied));
  const b = Buffer.from(env.admin.password);
  // timingSafeEqual throws on a length mismatch, which would itself be a
  // timing signal — hash both sides to a fixed width first.
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Signs in.
 *
 * The username is compared *after* the password, and both are always
 * evaluated, so a wrong username costs the same time as a wrong password —
 * otherwise the response time tells an attacker which half they got right.
 */
async function login({ username, password, ip }) {
  if (!env.admin.configured) {
    throw errors.adminNotConfigured();
  }

  const state = lockoutState(ip);
  if (state.locked) {
    throw errors.adminLockedOut(state.remaining);
  }

  const passwordOk = await passwordMatches(password ?? '');
  const usernameOk = String(username ?? '') === env.admin.username;

  if (!passwordOk || !usernameOk) {
    const entry = recordFailure(ip);
    const left = Math.max(0, env.admin.maxFailedLogins - entry.failures);
    throw errors.adminUnauthorized(
      left > 0
        ? `Incorrect username or password. ${left} ${left === 1 ? 'attempt' : 'attempts'} left.`
        : 'Too many failed attempts. This address is locked out.',
      'ADMIN_BAD_CREDENTIALS'
    );
  }

  clearFailures(ip);

  // A per-session id, so a token can be recognised in the audit log and so
  // two sign-ins are distinguishable.
  const sessionId = crypto.randomUUID();
  const token = jwt.sign({ sub: ADMIN_SUBJECT, sid: sessionId, typ: 'admin' }, env.admin.jwtSecret, {
    expiresIn: env.admin.sessionExpiry,
    issuer: ISSUER,
    audience: AUDIENCE,
  });

  const { exp } = jwt.decode(token);
  return {
    token,
    session_id: sessionId,
    username: env.admin.username,
    expires_at: new Date(exp * 1000).toISOString(),
  };
}

/** Verifies a token from the Authorization header. Throws if it is not ours. */
function verify(token) {
  try {
    const payload = jwt.verify(token, env.admin.jwtSecret, {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (payload.typ !== 'admin' || payload.sub !== ADMIN_SUBJECT) {
      throw new Error('not an admin token');
    }
    return payload;
  } catch (err) {
    // Expiry is worth distinguishing: the UI signs the operator out quietly
    // rather than showing them a failure they did not cause.
    if (err.name === 'TokenExpiredError') {
      throw errors.adminUnauthorized(
        'Your session has expired. Sign in again.',
        'ADMIN_SESSION_EXPIRED'
      );
    }
    throw errors.adminUnauthorized();
  }
}

module.exports = { login, verify, lockoutState, ADMIN_SUBJECT };
