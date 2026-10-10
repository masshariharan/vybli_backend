'use strict';

const profileService = require('../services/profile.service');
const settingsService = require('../services/settings.service');
const referenceService = require('../services/reference.service');
const favoriteService = require('../services/favorite.service');
const serialize = require('../utils/serialize');
const prisma = require('../config/prisma');
const { districtAt } = require('../services/geo/district.service');
const { ok } = require('../utils/respond');

async function getMe(req, res) {
  const user = await profileService.getMyProfile(req.userId);
  return ok(res, { user: serialize.myProfile(user) }, 'Your profile');
}

async function updateMe(req, res) {
  const user = await profileService.updateProfile(req.user, req.body);
  return ok(res, { user: serialize.myProfile(user) }, 'Profile updated');
}

/** Someone else's profile. */
async function getPublic(req, res) {
  const [{ user }, favorited] = await Promise.all([
    profileService.getPublicProfile(req.user, req.params.id),
    favoriteService.isFavorite(req.userId, req.params.id),
  ]);
  return ok(
    res,
    {
      user: serialize.publicUser(user, {
        viewer: req.userId,
        viewerProfile: req.user.profile,
        viewerPrivacy: req.user.privacySettings,
        favorited,
      }),
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

/**
 * The codes this account speaks, in the order they were chosen.
 *
 * Codes, not rendered languages: the catalogue lives in the app, so a name is
 * something the caller resolves rather than something this endpoint knows.
 */
async function getMyLanguages(req, res) {
  const rows = await referenceService.getUserLanguages(req.userId);
  return ok(res, { languages: rows.map((r) => r.languageCode) }, 'Your languages');
}

async function setMyLanguages(req, res) {
  const user = await profileService.updateProfile(req.user, {
    language_codes: req.body.language_codes,
  });
  return ok(res, { user: serialize.myProfile(user) }, 'Languages updated');
}

/**
 * Points the profile at one of the predefined avatars.
 *
 * The only way an avatar is ever set. There is no upload: `avatar_id` names
 * one of the server's own catalogued images, checked against it, so a
 * client can never point a profile at an arbitrary URL or file.
 */
async function setAvatar(req, res) {
  const user = await profileService.setAvatarId(req.userId, req.body.avatar_id);
  return ok(res, { user: serialize.myProfile(user) }, 'Avatar updated');
}

/**
 * Records the phone's last live fix, and answers with where it is: the
 * district and state by the official boundaries (see `geo/district.service`),
 * and the area as the phone named it.
 *
 * The boundaries decide the district and state. The phone's own geocoder is
 * the fallback for a point they do not cover (offshore, abroad), since it
 * often names the taluk rather than the district, or nothing at all.
 *
 * Nothing about the account changes — not the city, which the app sets on
 * its own through `PATCH /me` — and other users never see any of this.
 */
async function setLocation(req, res) {
  const b = req.body;
  const official = districtAt(b.lat, b.lng);
  const place = {
    area: b.area || null,
    district: official?.district ?? b.district ?? null,
    state: official?.state ?? b.state ?? null,
  };
  await prisma.userProfile.update({
    where: { userId: req.userId },
    data: {
      locationLat: b.lat,
      locationLng: b.lng,
      locationAccuracy: b.accuracy_m ?? null,
      locationArea: place.area,
      locationDistrict: place.district,
      locationState: place.state,
      locatedAt: new Date(),
    },
  });
  return ok(res, { place }, 'Location recorded');
}

module.exports = {
  getMe,
  setLocation,
  setAvatar,
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
