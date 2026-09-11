'use strict';

const authService = require('../services/auth.service');
const serialize = require('../utils/serialize');
const { ok, created } = require('../utils/respond');

/**
 * Controllers translate HTTP into a service call and a response shape.
 *
 * No business rules live here. If a controller starts branching on something
 * other than the shape of the request, that decision belongs in a service —
 * otherwise the same rule ends up implemented once for REST and again for the
 * socket handlers.
 */

async function requestOtp(req, res) {
  const result = await authService.requestOtp({
    dialCode: req.body.dial_code,
    phone: req.body.phone,
  });
  return ok(res, result, 'Verification code sent');
}

async function verifyOtp(req, res) {
  const result = await authService.verifyOtpAndSignIn({
    dialCode: req.body.dial_code,
    phone: req.body.phone,
    code: req.body.code,
    device: req.body.device,
    ip: req.ip,
  });

  const body = {
    access_token: result.access_token,
    refresh_token: result.refresh_token,
    token_type: result.token_type,
    is_new_user: result.is_new_user,
    onboarding_status: result.onboarding_status,
    user: serialize.myProfile(result.user),
  };

  return result.is_new_user
    ? created(res, body, 'Welcome to Vybli')
    : ok(res, body, 'Signed in');
}

/**
 * Exchanges a Firebase ID token for a Vybli session.
 *
 * The response is deliberately identical to the OTP path's, so the app can
 * swap which one it calls without any other change.
 */
async function firebaseSignIn(req, res) {
  const result = await authService.signInWithFirebase({
    idToken: req.body.id_token,
    device: req.body.device,
    ip: req.ip,
  });

  return ok(
    res,
    {
      access_token: result.access_token,
      refresh_token: result.refresh_token,
      token_type: result.token_type,
      is_new_user: result.is_new_user,
      onboarding_status: result.onboarding_status,
      user: serialize.myProfile(result.user),
    },
    result.is_new_user ? 'Welcome to Vybli' : 'Signed in'
  );
}


async function refresh(req, res) {
  const result = await authService.refresh({
    refreshToken: req.body.refresh_token,
    device: req.body.device,
    ip: req.ip,
  });
  return ok(
    res,
    {
      access_token: result.access_token,
      refresh_token: result.refresh_token,
      token_type: result.token_type,
      user: serialize.myProfile(result.user),
    },
    'Session refreshed'
  );
}

async function logout(req, res) {
  const result = await authService.logout({
    userId: req.userId,
    refreshToken: req.body.refresh_token,
    allDevices: req.body.all_devices,
  });
  return ok(res, result, 'Signed out');
}

async function deleteAccount(req, res) {
  const result = await authService.deleteAccount({
    user: req.user,
    reason: req.body?.reason,
  });
  return ok(res, result, 'Your account has been deleted');
}

/** Cheap "is my token still good" check for a client resuming from cold. */
async function me(req, res) {
  return ok(res, { user: serialize.myProfile(req.user) }, 'Signed in');
}

module.exports = {
  requestOtp,
  verifyOtp,
  firebaseSignIn,
  refresh,
  logout,
  deleteAccount,
  me,
};
