'use strict';

const onboardingService = require('../services/onboarding.service');
const serialize = require('../utils/serialize');
const { ok } = require('../utils/respond');

/**
 * Every step answers with the same shape — the new status, the step to show
 * next, and the refreshed profile — so the client has one handler for all of
 * them rather than six slightly different ones.
 */
function stepResponse(res, result, message) {
  return ok(
    res,
    {
      onboarding_status: result.status,
      next_step: result.next_step ?? null,
      user: result.user ? serialize.myProfile(result.user) : undefined,
    },
    message
  );
}

async function getStatus(req, res) {
  const status = await onboardingService.getStatus(req.user);
  return ok(res, status, 'Onboarding status');
}

async function setGender(req, res) {
  const result = await onboardingService.setGender(req.user, req.body.gender);
  return stepResponse(res, result, 'Saved');
}

async function setAge(req, res) {
  const result = await onboardingService.setAge(req.user, req.body.age);
  return stepResponse(res, result, 'Saved');
}

async function setLanguages(req, res) {
  const result = await onboardingService.setLanguages(req.user, req.body.language_codes);
  return stepResponse(res, result, 'Languages saved');
}

async function setLocation(req, res) {
  const result = await onboardingService.setLocation(req.user, req.body.city_id);
  return stepResponse(res, result, 'City saved');
}

async function setProfileBasics(req, res) {
  const result = await onboardingService.setProfileBasics(req.user, {
    name: req.body.name,
    bio: req.body.bio,
  });
  return stepResponse(res, result, 'Saved');
}

async function complete(req, res) {
  const result = await onboardingService.complete(req.user);
  return stepResponse(res, result, "You're all set");
}

module.exports = {
  getStatus,
  setGender,
  setAge,
  setLanguages,
  setLocation,
  setProfileBasics,
  complete,
};
