'use strict';

const profileService = require('../services/profile.service');
const settingsService = require('../services/settings.service');
const referenceService = require('../services/reference.service');
const favoriteService = require('../services/favorite.service');
const serialize = require('../utils/serialize');
const { ok } = require('../utils/respond');
const storage = require('../services/storage.service');
const { errors, AppError } = require('../utils/errors');

async function getMe(req, res) {
  const user = await profileService.getMyProfile(req.userId);
  return ok(res, { user: serialize.myProfile(user) }, 'Your profile');
}

async function updateMe(req, res) {
  const user = await profileService.updateProfile(req.user, req.body);
  return ok(res, { user: serialize.myProfile(user) }, 'Profile updated');
}

/**
 * Someone else's profile.
 *
 * Ships the relationship alongside it so the client can pick its primary
 * button — Add Friend / Requested / Accept / Message — without a second
 * round trip to work out where the two of them stand.
 */
async function getPublic(req, res) {
  const [{ user, connectionStatus }, favorited] = await Promise.all([
    profileService.getPublicProfile(req.user, req.params.id),
    favoriteService.isFavorite(req.userId, req.params.id),
  ]);
  return ok(
    res,
    {
      user: serialize.publicUser(user, {
        viewer: req.userId,
        viewerProfile: req.user.profile,
        favorited,
      }),
      connection_status: connectionStatus,
    },
    'Profile'
  );
}

async function setPresence(req, res) {
  const profile = await profileService.setPresence(req.userId, req.body.status);
  return ok(
    res,
    { status: profile.presence, last_seen: serialize.iso(profile.lastSeen) },
    'Presence updated'
  );
}

// ── Settings ────────────────────────────────────────────────────────────────

async function getPrivacy(req, res) {
  const settings = await settingsService.getPrivacy(req.userId);
  return ok(res, { privacy: serialize.privacySettings(settings) }, 'Privacy settings');
}

async function updatePrivacy(req, res) {
  const settings = await settingsService.updatePrivacy(req.userId, req.body);
  return ok(res, { privacy: serialize.privacySettings(settings) }, 'Privacy updated');
}

async function getNotificationSettings(req, res) {
  const settings = await settingsService.getNotifications(req.userId);
  return ok(
    res,
    { notifications: serialize.notificationSettings(settings) },
    'Notification settings'
  );
}

async function updateNotificationSettings(req, res) {
  const settings = await settingsService.updateNotifications(req.userId, req.body);
  return ok(
    res,
    { notifications: serialize.notificationSettings(settings) },
    'Notification settings updated'
  );
}

async function getDiscoverySettings(req, res) {
  const settings = await settingsService.getDiscovery(req.userId);
  return ok(
    res,
    { discovery: serialize.discoverySettings(settings) },
    'Discovery settings'
  );
}

async function updateDiscoverySettings(req, res) {
  const settings = await settingsService.updateDiscovery(req.userId, req.body);
  return ok(
    res,
    { discovery: serialize.discoverySettings(settings) },
    'Filters applied'
  );
}

async function resetDiscoverySettings(req, res) {
  const settings = await settingsService.resetDiscovery(req.userId);
  return ok(
    res,
    { discovery: serialize.discoverySettings(settings) },
    'Filters reset'
  );
}

// ── Languages on the profile ────────────────────────────────────────────────

async function getMyLanguages(req, res) {
  const rows = await referenceService.getUserLanguages(req.userId);
  return ok(
    res,
    { languages: rows.map((r) => serialize.language(r.language)) },
    'Your languages'
  );
}

async function setMyLanguages(req, res) {
  const user = await profileService.updateProfile(req.user, {
    language_codes: req.body.language_codes,
  });
  return ok(res, { user: serialize.myProfile(user) }, 'Languages updated');
}

/**
 * Uploads a profile photo.
 *
 * The upload endpoint is the *only* way an avatar URL is set. `avatar_url` was
 * previously a writable field on `PATCH /me`, which let a client point their
 * profile at any URL on the internet — someone else's bandwidth, a tracking
 * pixel, or content this platform would be responsible for showing but had
 * never seen. Now the bytes arrive here, get checked, and the server decides
 * the URL.
 */
async function uploadAvatar(req, res) {
  if (!req.file || !req.file.buffer) {
    throw errors.badRequest('Attach an image as the "photo" field.');
  }

  let stored;
  try {
    stored = await storage.putAvatar(req.userId, req.file.buffer);
  } catch (error) {
    if (!(error instanceof storage.StorageError)) throw error;
    // The distinction matters to the app: it should tell the user to pick a
    // different picture for one of these, and offer a retry for the other.
    if (error.code === 'unavailable' || error.code === 'not_configured') {
      throw new AppError(error.message, {
        status: 503,
        code: 'STORAGE_UNAVAILABLE',
      });
    }
    throw errors.badRequest(error.message);
  }

  const user = await profileService.setAvatar(req.userId, stored.url);
  return ok(res, { user: serialize.myProfile(user) }, 'Photo updated');
}

/** Removes the photo. The profile falls back to initials. */
async function deleteAvatar(req, res) {
  const user = await profileService.clearAvatar(req.userId);
  return ok(res, { user: serialize.myProfile(user) }, 'Photo removed');
}

module.exports = {
  getMe,
  uploadAvatar,
  deleteAvatar,
  updateMe,
  getPublic,
  setPresence,
  getPrivacy,
  updatePrivacy,
  getNotificationSettings,
  updateNotificationSettings,
  getDiscoverySettings,
  updateDiscoverySettings,
  resetDiscoverySettings,
  getMyLanguages,
  setMyLanguages,
};
