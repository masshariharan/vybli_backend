'use strict';

const livekit = require('../services/livekit.service');
const callService = require('../services/call.service');
const env = require('../config/env');

/**
 * LiveKit's webhook.
 *
 * This exists to close one gap that nothing else can: a phone that stops
 * talking without telling the API. Signal drops, battery dies, the app is
 * force-stopped from the task switcher. No hang-up request arrives, the socket
 * may take a minute to time out, and in the meantime the billing ticker is
 * still charging a caller whose phone is dead in their pocket.
 *
 * LiveKit knows within seconds, because it is the one holding the media
 * connection. So it tells us, and we end the call.
 *
 * The endpoint is unauthenticated in the usual sense — LiveKit calls it from
 * its own infrastructure with no user session — so the **signature is the only
 * thing protecting it**, and these events end calls. It is verified before the
 * body is looked at, in [livekit.service.verifyWebhook].
 */
async function webhook(req, res) {
  // Verification needs the bytes exactly as they were signed. The route mounts
  // `express.raw`, so `req.body` is a Buffer rather than a parsed object.
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body;
  const event = await livekit.verifyWebhook(raw, req.get('Authorization'));

  const callId =
    livekit.callIdFromRoom(event?.room?.name) ||
    livekit.callIdFromRoom(event?.egressInfo?.roomName);

  // A room we did not create, or an event about something other than a room.
  // Answer 200 regardless: a non-2xx makes LiveKit retry, and retrying an
  // event we will never care about is pure noise.
  if (!callId) return res.json({ success: true, data: { ignored: event?.event } });

  try {
    switch (event.event) {
      // One side's media is gone. On a connected call that is the end of it —
      // a two-person call with one person left is over, whatever the reason.
      case 'participant_left':
        await callService.onMediaDisconnect(callId, { reason: 'networkError' });
        break;

      // The room closed without us closing it: everyone left, or it hit the
      // empty timeout. Same conclusion, and harmless if we closed it ourselves
      // — `onMediaDisconnect` ignores a call that is already ended.
      case 'room_finished':
        await callService.onMediaDisconnect(callId, { reason: 'networkError' });
        break;

      default:
        break;
    }
  } catch (err) {
    // Swallowed on purpose. The alternative is a non-2xx, which makes LiveKit
    // redeliver — and redelivering an event that already ended the call just
    // repeats work. The log is what a human needs here.
    console.error('[livekit] webhook handling failed', event.event, callId, err.message);
  }

  return res.json({ success: true, data: { handled: event.event, call_id: callId } });
}

/**
 * Whether this server can carry media, and where.
 *
 * The app reads it at startup to decide whether to offer calling at all —
 * better a disabled button with a reason than one that rings into silence.
 */
function status(_req, res) {
  return res.json({
    success: true,
    message: 'LiveKit status',
    data: {
      configured: env.livekit.configured,
      // The URL is not a secret — every client needs it to connect. The API
      // key and secret never leave the server.
      url: env.livekit.configured ? env.livekit.url : null,
    },
  });
}

module.exports = { webhook, status };
