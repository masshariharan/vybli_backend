'use strict';

const prisma = require('../config/prisma');
const { errors } = require('../utils/errors');
const activity = require('./activity.service');
const { emitToAdmin } = require('../sockets/bus');
const { USER_INCLUDE } = require('./auth.service');

/**
 * Resumable sign-up.
 *
 * Each step commits on its own, so closing the app halfway costs nothing —
 * the client asks for the status and is sent straight to the step it names.
 * The client's own draft object is a convenience, not the record.
 *
 * Status only ever moves **forward**. Editing your gender after picking a city
 * must not drag you back three screens, so a step already behind you updates
 * the value and leaves the status where it is.
 */

/** In screen order. Index doubles as rank for the forward-only rule. */
const STEP_ORDER = [
  'PHONE_VERIFIED',
  'GENDER_COMPLETED',
  'AGE_COMPLETED',
  'LANGUAGE_COMPLETED',
  'LOCATION_COMPLETED',
  'MODE_SELECTED',
  'ONBOARDING_COMPLETED',
];

const rank = (status) => STEP_ORDER.indexOf(status);

/** The later of the two, so a re-edit cannot regress progress. */
function advance(current, target) {
  return rank(target) > rank(current) ? target : current;
}

/**
 * What the client should show next.
 *
 * Returned by every step and by `GET /onboarding/status`, so there is one
 * answer to "where am I" rather than the client inferring it from which
 * fields happen to be filled.
 */
function nextStep(status, { isEarner = false, hasPhoto = false } = {}) {
  switch (status) {
    case 'PHONE_VERIFIED':
      return 'gender';
    case 'GENDER_COMPLETED':
      return 'age';
    case 'AGE_COMPLETED':
      return 'languages';
    case 'LANGUAGE_COMPLETED':
      return 'location';
    case 'LOCATION_COMPLETED':
      return 'mode';
    case 'MODE_SELECTED':
      // Only the Earn Money branch needs a photo. A friends account is
      // finished the moment it picks up a mode. Identity review happens
      // afterwards, manually, and is not a step of onboarding at all.
      if (!isEarner) return 'complete';
      return hasPhoto ? 'complete' : 'photo';
    case 'ONBOARDING_COMPLETED':
    default:
      return null;
  }
}

async function reload(userId) {
  return prisma.user.findUnique({ where: { id: userId }, include: USER_INCLUDE });
}

/** Applies a step and returns the refreshed user plus the new status. */
async function applyStep(user, data, targetStatus) {
  const current = user.profile?.onboardingStatus ?? 'PHONE_VERIFIED';
  await prisma.userProfile.update({
    where: { userId: user.id },
    data: { ...data, onboardingStatus: advance(current, targetStatus) },
  });
  const fresh = await reload(user.id);

  // Every onboarding step funnels through here, so one call covers gender,
  // age, location and mode. Recording at each caller instead would mean four
  // places to forget.
  activity.record({
    userId: user.id,
    type: targetStatus === 'LOCATION_COMPLETED' ? 'location_updated' : 'onboarding_step',
    description: `Onboarding — ${STEP_LABELS[targetStatus] ?? targetStatus}`,
    metadata: { from: current, to: fresh.profile.onboardingStatus, fields: Object.keys(data) },
    status: fresh.profile.onboardingStatus,
  });

  return {
    user: fresh,
    status: fresh.profile.onboardingStatus,
    next_step: nextStep(fresh.profile.onboardingStatus, {
      isEarner: fresh.profile.isEarner,
      hasPhoto: Boolean(fresh.profile.avatarId),
    }),
  };
}

/** Human wording for the timeline, so it does not read as a screaming enum. */
const STEP_LABELS = {
  GENDER_COMPLETED: 'gender selected',
  AGE_COMPLETED: 'age entered',
  LANGUAGE_COMPLETED: 'languages chosen',
  LOCATION_COMPLETED: 'city confirmed',
  MODE_SELECTED: 'account type chosen',
  ONBOARDING_COMPLETED: 'finished',
};

const setGender = (user, gender) => applyStep(user, { gender }, 'GENDER_COMPLETED');
const setAge = (user, age) => applyStep(user, { age }, 'AGE_COMPLETED');

/**
 * Replaces the user's languages.
 *
 * The codes are stored as sent. There is no catalogue here to check them
 * against any more — it belongs to the client, which is the only party that
 * renders a language — and a code this server has not heard of is a language a
 * newer app knows about rather than a fault. What is still enforced is shape
 * and count, by `S.onboarding.languages`, and *deduplication* here: the
 * composite key would otherwise reject the whole write over a repeat.
 */
async function setLanguages(user, languageCodes) {
  const codes = [...new Set(languageCodes)];
  const current = user.profile?.onboardingStatus ?? 'PHONE_VERIFIED';

  await prisma.$transaction([
    prisma.userLanguage.deleteMany({ where: { userId: user.id } }),
    prisma.userLanguage.createMany({
      data: codes.map((code) => ({ userId: user.id, languageCode: code })),
    }),
    prisma.userProfile.update({
      where: { userId: user.id },
      data: { onboardingStatus: advance(current, 'LANGUAGE_COMPLETED') },
    }),
  ]);

  activity.record({
    userId: user.id,
    type: 'language_updated',
    description: `Chose ${codes.join(', ')}`,
    metadata: { languages: codes },
  });

  const fresh = await reload(user.id);
  return {
    user: fresh,
    status: fresh.profile.onboardingStatus,
    next_step: nextStep(fresh.profile.onboardingStatus, {
      isEarner: fresh.profile.isEarner,
      hasPhoto: Boolean(fresh.profile.avatarId),
    }),
  };
}

/**
 * Locks in the city, then the role that follows from it.
 *
 * There is no longer a screen that asks Make Friends or Earn Money — gender
 * decides that outright, so the moment the location step lands is the moment
 * the role can too. `isEarner` is set from the derived goal in the same
 * write: they are two fields that could disagree, and an account that had
 * accepted the earning terms but was not flagged as an earner could never be
 * discovered or called — the exact inconsistency the client had before its
 * audit.
 *
 * Verification is *not* granted here. An earner is discoverable only after an
 * administrator has reviewed the account, which happens after onboarding
 * finishes — see [complete].
 */
async function setLocation(user, cityId) {
  const city = await prisma.city.findUnique({ where: { id: cityId } });
  if (!city) throw errors.notFound('City', 'CITY_NOT_FOUND');
  const afterLocation = await applyStep(user, { cityId }, 'LOCATION_COMPLETED');

  const goal = afterLocation.user.profile.gender === 'female' ? 'earnMoney' : 'makeFriends';
  return applyStep(afterLocation.user, { goal, isEarner: goal === 'earnMoney' }, 'MODE_SELECTED');
}

/** Name and bio. Available during sign-up and again from Edit Profile. */
async function setProfileBasics(user, { name, bio }) {
  const data = { name };
  if (bio !== undefined) data.bio = bio;
  const current = user.profile?.onboardingStatus ?? 'PHONE_VERIFIED';
  await prisma.userProfile.update({
    where: { userId: user.id },
    data: { ...data, onboardingStatus: current },
  });
  const fresh = await reload(user.id);
  return { user: fresh, status: fresh.profile.onboardingStatus };
}

/**
 * Finishes sign-up.
 *
 * Re-checks the whole thing rather than trusting the status column: a client
 * that skipped a step and called this directly would otherwise land on the
 * feed with no city and no languages, invisible to discovery and unable to
 * match. The reply names the first missing piece so the client can go there.
 */
async function complete(user) {
  const profile = user.profile;
  if (!profile) throw errors.notFound('Profile', 'PROFILE_NOT_FOUND');

  const languageCount = await prisma.userLanguage.count({ where: { userId: user.id } });

  const missing = [];
  if (!profile.name?.trim()) missing.push('name');
  if (!profile.gender) missing.push('gender');
  if (!profile.age || profile.age < 18) missing.push('age');
  if (languageCount === 0) missing.push('languages');
  if (!profile.cityId) missing.push('location');
  if (rank(profile.onboardingStatus) < rank('MODE_SELECTED')) missing.push('mode');

  // A profile picture is how a caller decides whether to answer — an earner
  // with no photo is a name and a price, nothing to go on.
  if (profile.isEarner && !profile.avatarId) missing.push('photo');

  if (missing.length > 0) {
    throw errors.badRequest('A few things are still missing', {
      missing,
      next_step: missing[0],
    });
  }

  // An earner's identity review starts the moment onboarding does —
  // `not_required` is the only state that can still be sitting here, since
  // nothing ever moves it backwards once a decision (or a fresh request) has
  // been made. The account is not discoverable or payable until an
  // administrator acts on it from the `/verifications` queue.
  const startsReview = profile.isEarner && profile.verificationStatus === 'not_required';

  await prisma.userProfile.update({
    where: { userId: user.id },
    data: {
      onboardingStatus: 'ONBOARDING_COMPLETED',
      ...(startsReview
        ? { verificationStatus: 'pending', verificationRequestedAt: new Date() }
        : {}),
    },
  });

  if (startsReview) {
    activity.record({
      userId: user.id,
      type: 'verification_requested',
      description: 'Queued for identity review after finishing onboarding',
      status: 'pending',
    });
    emitToAdmin('admin:verification_pending', {
      user_id: user.id,
      name: profile.name ?? null,
      at: new Date().toISOString(),
    });
  }

  const fresh = await reload(user.id);
  return { user: fresh, status: 'ONBOARDING_COMPLETED', next_step: null };
}

/** Where the user is, for a client resuming after a restart. */
async function getStatus(user) {
  const profile = user.profile;
  const languageCount = await prisma.userLanguage.count({ where: { userId: user.id } });

  return {
    status: profile?.onboardingStatus ?? 'PHONE_VERIFIED',
    next_step: nextStep(profile?.onboardingStatus ?? 'PHONE_VERIFIED', {
      isEarner: profile?.isEarner ?? false,
      hasPhoto: Boolean(profile?.avatarId),
    }),
    is_complete: profile?.onboardingStatus === 'ONBOARDING_COMPLETED',
    // What is already answered, so the client can prefill rather than re-ask.
    completed: {
      gender: Boolean(profile?.gender) && rank(profile.onboardingStatus) >= rank('GENDER_COMPLETED'),
      age: Boolean(profile?.age) && rank(profile.onboardingStatus) >= rank('AGE_COMPLETED'),
      languages: languageCount > 0,
      location: Boolean(profile?.cityId),
      mode: rank(profile?.onboardingStatus ?? '') >= rank('MODE_SELECTED'),
      photo: Boolean(profile?.avatarId),
      verification: Boolean(profile?.isVerified),
      name: Boolean(profile?.name?.trim()),
    },
    goal: profile?.goal ?? null,
    is_earner: profile?.isEarner ?? false,
  };
}

module.exports = {
  STEP_ORDER,
  nextStep,
  setGender,
  setAge,
  setLanguages,
  setLocation,
  setProfileBasics,
  complete,
  getStatus,
  advance,
};
