'use strict';

/**
 * Where an earner's identity review stands.
 *
 * There is nothing here to submit — no recording, no upload. Review is
 * manual and administrator-driven: `onboardingService.complete` queues an
 * earner as `pending` the moment onboarding finishes, and
 * `platform.decideVerification` is the only thing that ever moves it to
 * `verified` or `rejected`. This module only reports the current state, off
 * the profile already attached to `req.user`.
 */

async function status(user) {
  const profile = user.profile;
  return {
    is_verified: profile?.isVerified ?? false,
    status: profile?.verificationStatus ?? 'not_required',
    rejection_reason: profile?.rejectionReason ?? null,
  };
}

module.exports = { status };
