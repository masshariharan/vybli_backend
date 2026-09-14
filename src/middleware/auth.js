'use strict';

const prisma = require('../config/prisma');
const { errors } = require('../utils/errors');
const { verifyAccessToken } = require('../utils/tokens');
const { STEP_ORDER } = require('../services/onboarding.service');

const stepRank = (status) => STEP_ORDER.indexOf(status);

/**
 * Establishes who is calling.
 *
 * The user id comes from the **signed token and nowhere else**. No endpoint in
 * this API accepts a `userId` in a body or a query string to mean "who I am";
 * doing so would let anyone act as anyone by editing a request.
 */

function bearerFrom(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

/**
 * Loads the caller, or fails.
 *
 * The profile and privacy settings are joined in because nearly every guarded
 * route needs at least one of them, and a second round trip per request to
 * fetch them separately is worse than one slightly wider read.
 */
async function authenticate(req, _res, next) {
  try {
    const token = bearerFrom(req);
    if (!token) throw errors.unauthorized();

    const payload = verifyAccessToken(token);

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      include: {
        profile: true,
        privacySettings: true,
        // The one sign-in this token belongs to, fetched in the same round
        // trip as the user rather than a second query on every request.
        // Filtered to a single id, so this stays a lookup and not a scan of
        // everything the account has ever opened.
        ...(payload.sid
          ? {
              sessions: {
                where: { id: payload.sid },
                select: { id: true, revokedAt: true, expiresAt: true },
              },
            }
          : {}),
      },
    });

    if (!user || user.status === 'deleted' || user.deletedAt) {
      throw errors.invalidToken('This account no longer exists.');
    }
    if (user.status === 'suspended') throw errors.accountSuspended();

    // One session per account, enforced where it actually matters.
    //
    // Revoking the row alone only stops the *refresh* — the access token is
    // verified by signature and would go on working until it expired, so
    // signing in on a new phone left the old one usable for another fifteen
    // minutes. Checking the session here is what makes "signed in elsewhere"
    // take effect on the very next request.
    //
    // A token with no `sid` predates this and is allowed through: it can no
    // longer be minted, and every one still in circulation expires within the
    // access token's own lifetime, so the exception closes itself rather than
    // signing out everybody who was already using the app at deploy time.
    if (payload.sid) {
      const session = user.sessions?.[0];
      if (!session || session.revokedAt || session.expiresAt < new Date()) {
        throw errors.invalidToken('You signed in on another device.');
      }
    }

    req.user = user;
    req.userId = user.id;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Requires a finished sign-up.
 *
 * Onboarding endpoints deliberately skip this — they are how you get out of
 * the incomplete state. Everything else needs a real profile behind it, and
 * the error carries the step to resume at so the client can route there
 * instead of guessing.
 *
 * An Earn Money account that picked its mode but deferred voice verification
 * (the onboarding flow's own "Later" button) is a deliberate, supported
 * in-between state — not an incomplete profile. It can use the rest of the
 * app; it just is not discoverable yet, which `onboardingStatus` still gates
 * separately on the feed query. Blocking it here too used to strand every
 * such account on "Finish setting up your account first" with no route back
 * except the one screen it just chose to skip.
 */
function requireOnboarded(req, _res, next) {
  const profile = req.user?.profile;
  const status = profile?.onboardingStatus;
  if (status === 'ONBOARDING_COMPLETED') return next();
  if (profile?.isEarner && stepRank(status) >= stepRank('MODE_SELECTED')) {
    return next();
  }
  return next(errors.onboardingIncomplete(status ?? 'PHONE_VERIFIED'));
}

/**
 * Restricts a route to Earn Money accounts.
 *
 * Earnings, withdrawals and the received-requests list only exist for them;
 * for anyone else the answer is not "empty", it is "this does not apply".
 */
function requireEarner(req, _res, next) {
  if (!req.user?.profile?.isEarner) return next(errors.notAnEarnerAccount());
  next();
}

/**
 * Attaches the caller when a token is present but does not insist on one.
 *
 * For endpoints that are richer when signed in and still valid when not.
 */
async function optionalAuth(req, _res, next) {
  if (!bearerFrom(req)) return next();
  try {
    await authenticate(req, _res, next);
  } catch {
    next();
  }
}

module.exports = { authenticate, requireOnboarded, requireEarner, optionalAuth };
