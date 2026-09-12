'use strict';

const {
  AccessToken,
  RoomServiceClient,
  WebhookReceiver,
  TrackSource,
} = require('livekit-server-sdk');

const env = require('../config/env');
const { errors } = require('../utils/errors');

/**
 * The media path.
 *
 * LiveKit carries the audio and video and nothing else. It does not decide who
 * may call whom, when a call starts, what it costs, or when it ends — all of
 * that is [call.service] talking to Postgres. This module's whole job is to
 * hand each participant a token scoped to one room, and to tear that room down
 * when the call is over.
 *
 * Keeping the split that sharp matters for one reason above all: **the billing
 * clock must not be able to disagree with the media session.** So the room is
 * named after the call id, exactly two identities may ever join it, and the
 * server closes it the instant the call ends — including the out-of-balance
 * cut-off, where a room left open would mean free minutes.
 */

/** One room per call, named so a support engineer can find it from a call id. */
function roomName(callId) {
  return `call_${callId}`;
}

/** A participant identity is the user id — the webhook maps it straight back. */
function identityFor(userId) {
  return userId;
}

let roomClient = null;

/**
 * The management client, built lazily.
 *
 * [env] already refuses to boot at all without real LiveKit credentials —
 * see its own guard — so by the time this runs, `env.livekit.configured` is
 * always true. The check stays anyway: a function whose one job is deciding
 * whether to build this client should not simply trust that it always will.
 */
function client() {
  if (!env.livekit.configured) return null;
  if (!roomClient) {
    roomClient = new RoomServiceClient(
      httpUrl(env.livekit.url),
      env.livekit.apiKey,
      env.livekit.apiSecret
    );
  }
  return roomClient;
}

/** The SDK's REST client wants http(s), while clients connect over ws(s). */
function httpUrl(url) {
  return url.replace(/^ws/, 'http');
}

/**
 * Mints a join token for one participant of one call.
 *
 * The grant is deliberately narrow:
 *
 *  * `roomJoin` for **this** room only, so a leaked token cannot be used to
 *    walk into somebody else's conversation.
 *  * `canPublishSources` limited to the microphone on a voice call. A video
 *    grant on a voice call would let a modified client bill at the voice rate
 *    while sending video, which is a paid feature.
 *  * `canUpdateOwnMetadata` off — nothing reads participant metadata, and an
 *    unread field is somewhere for a client to put something we then trust.
 *
 * Returns null when LiveKit is not configured, which lets a development server
 * run the rest of the product. Every caller treats null as "no media".
 */
async function issueToken({ call, userId, displayName }) {
  if (!env.livekit.configured) return null;

  const isVideo = call.type === 'video';
  const token = new AccessToken(env.livekit.apiKey, env.livekit.apiSecret, {
    identity: identityFor(userId),
    name: displayName || undefined,
    ttl: env.livekit.tokenTtlSeconds,
  });

  token.addGrant({
    room: roomName(call.id),
    roomJoin: true,
    canSubscribe: true,
    canPublish: true,
    canPublishData: false,
    canUpdateOwnMetadata: false,
    canPublishSources: isVideo
      ? [TrackSource.MICROPHONE, TrackSource.CAMERA]
      : [TrackSource.MICROPHONE],
  });

  return {
    url: env.livekit.url,
    room: roomName(call.id),
    token: await token.toJwt(),
    // The client shows a camera button only when it may actually publish one.
    can_publish_video: isVideo,
  };
}

/**
 * Closes the room, disconnecting whoever is still in it.
 *
 * Called on **every** path that ends a call — hang-up, rejection, ring
 * timeout, the out-of-balance cut-off, a block mid-call. Never left to LiveKit's
 * empty-room timeout: between the server deciding a call is over and the room
 * emptying itself, two people would still be talking on a call that has
 * stopped charging.
 *
 * Failures are logged and swallowed. The call is over in the database either
 * way, and throwing here would turn a tidy-up problem into a failed hang-up.
 */
async function closeRoom(callId) {
  const service = client();
  if (!service) return;
  try {
    await service.deleteRoom(roomName(callId));
  } catch (err) {
    // A room nobody ever joined does not exist, and deleting it 404s. That is
    // the common case for a call that was never answered, not an error.
    if (!isNotFound(err)) {
      console.error('[livekit] could not close room for call', callId, err.message);
    }
  }
}

/** Ejects one participant, leaving the room up for the other. */
async function removeParticipant(callId, userId) {
  const service = client();
  if (!service) return;
  try {
    await service.removeParticipant(roomName(callId), identityFor(userId));
  } catch (err) {
    if (!isNotFound(err)) {
      console.error('[livekit] could not remove participant', userId, err.message);
    }
  }
}

/**
 * Every room LiveKit currently has.
 *
 * For the admin panel's call monitor. Reads through the server rather than
 * letting the browser hold LiveKit credentials — an admin page with the API
 * secret in it is the secret published.
 */
async function listRooms() {
  const service = client();
  if (!service) return [];
  return service.listRooms();
}

/** Who is currently in the room. Used by the reconciler and by diagnostics. */
async function participants(callId) {
  const service = client();
  if (!service) return [];
  try {
    return await service.listParticipants(roomName(callId));
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}

function isNotFound(err) {
  const message = String(err?.message || '');
  return (
    err?.code === 'not_found' ||
    err?.status === 404 ||
    /not found|does not exist/i.test(message)
  );
}

let receiver = null;

/**
 * Verifies a webhook body against the API secret and returns the event.
 *
 * The endpoint is public — LiveKit calls it from its own infrastructure — so
 * the signature is the only thing standing between it and anyone who can POST
 * JSON. An unverified body must never reach the call service, because these
 * events end calls.
 */
async function verifyWebhook(rawBody, authHeader) {
  if (!env.livekit.configured) {
    throw errors.badRequest('LiveKit is not configured on this server.', 'LIVEKIT_DISABLED');
  }
  if (!authHeader) {
    throw errors.unauthorized('Missing webhook signature.', 'WEBHOOK_UNSIGNED');
  }
  if (!receiver) {
    receiver = new WebhookReceiver(env.livekit.apiKey, env.livekit.apiSecret);
  }
  try {
    return await receiver.receive(rawBody, authHeader);
  } catch {
    // The library's reason is not worth relaying: a signature either verifies
    // or it does not, and echoing the detail back would tell a prober how
    // close they got.
    throw errors.unauthorized('Webhook signature did not verify.', 'WEBHOOK_BAD_SIGNATURE');
  }
}

/** `call_<id>` back to `<id>`. Returns null for a room we did not create. */
function callIdFromRoom(name) {
  if (typeof name !== 'string' || !name.startsWith('call_')) return null;
  return name.slice('call_'.length) || null;
}

module.exports = {
  roomName,
  identityFor,
  listRooms,
  issueToken,
  closeRoom,
  removeParticipant,
  participants,
  verifyWebhook,
  callIdFromRoom,
  get configured() {
    return env.livekit.configured;
  },
};
