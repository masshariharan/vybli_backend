'use strict';

const e2eeService = require('../services/e2ee.service');
const chatService = require('../services/chat.service');
const { ok } = require('../utils/respond');

/** This phone's public key, registered or refreshed on every sign-in. */
async function registerDevice(req, res) {
  const device = await e2eeService.registerDevice(req.user, {
    deviceId: req.params.deviceId,
    publicKey: req.body.public_key,
    platform: req.body.platform,
  });
  return ok(res, { device }, 'Device registered');
}

/** Signing out: nothing is encrypted to this phone any more. */
async function revokeDevice(req, res) {
  await e2eeService.revokeDevice(req.user, req.params.deviceId);
  return ok(res, { revoked: true }, 'Device removed');
}

async function listDevices(req, res) {
  return ok(res, { devices: await e2eeService.listOwn(req.user) }, 'Devices');
}

/**
 * Both members' device keys — what a sender encrypts for and a reader looks a
 * sender's key up in. Only for a conversation the caller is in.
 */
async function conversationKeys(req, res) {
  const conversation = await chatService.getConversationOr404(req.params.id, req.userId);
  const devices = await e2eeService.devicesForConversation(conversation);
  return ok(res, { conversation_id: conversation.id, devices }, 'Keys');
}

/** Several contacts' device keys at once, for decrypting a page of previews. */
async function lookupDevices(req, res) {
  const devices = await e2eeService.devicesOfContacts(req.user, req.body.user_ids);
  return ok(res, { devices }, 'Keys');
}

module.exports = { registerDevice, revokeDevice, listDevices, conversationKeys, lookupDevices };
