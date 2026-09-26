'use strict';

const callService = require('../services/call.service');
const serialize = require('../utils/serialize');
const { ok, created, paginated } = require('../utils/respond');
const { q } = require('../middleware/validate');
const { toSkipTake } = require('../validators/common');

/**
 * Every reply that hands a live call to a client carries that client's own
 * LiveKit credentials, in `call.livekit`. One round trip, so there is never a
 * window where the app knows a call exists but cannot join its media.
 */
async function start(req, res) {
  const call = await callService.start(req.user, {
    userId: req.body.user_id,
    type: req.body.type,
    isRandom: req.body.is_random,
    clientId: req.body.client_id,
  });
  return created(res, { call: await callService.withMedia(call, req.userId) }, 'Calling…');
}

async function accept(req, res) {
  const call = await callService.accept(req.user, req.params.id);
  return ok(res, { call: await callService.withMedia(call, req.userId) }, 'Connected');
}

async function reject(req, res) {
  const call = await callService.reject(req.user, req.params.id);
  return ok(res, { call: await callService.withMedia(call, req.userId) }, 'Declined');
}

async function cancel(req, res) {
  const call = await callService.cancel(req.user, req.params.id);
  return ok(res, { call: await callService.withMedia(call, req.userId) }, 'Cancelled');
}

/**
 * A fresh join token for a call already in progress.
 *
 * Tokens are short-lived, and a long call plus a network drop can outlive one.
 * Rather than making them long-lived — a leaked long token is a way into
 * somebody's conversation — the client asks for another when it needs to
 * reconnect.
 */
async function token(req, res) {
  const call = await callService.loadCall(req.params.id);
  if (call.callerId !== req.userId && call.calleeId !== req.userId) {
    return res.status(403).json({
      success: false,
      message: 'That call is not yours.',
      error: 'NOT_CALL_PARTICIPANT',
    });
  }
  const payload = await callService.withMedia(call, req.userId);
  return ok(res, { livekit: payload.livekit }, 'Token issued');
}

/**
 * Ends a call.
 *
 * The reply carries the final duration and cost, which is what the summary
 * screen renders — computed server-side, so it always agrees with the wallet.
 */
async function end(req, res) {
  const call = await callService.end(req.user, req.params.id, {
    reason: req.body.reason,
  });
  return ok(
    res,
    {
      // Through `withMedia` like every other path, which returns `livekit:
      // null` for a finished call. Leaving the field off entirely would let a
      // client hold on to credentials for a room the server has just closed.
      call: await callService.withMedia(call, req.userId),
      summary: {
        duration_seconds: call.durationSeconds,
        // Whoever is not the earner paid for it, regardless of who placed
        // the call.
        amount_spent: (call.callerId === req.userId ? call.caller : call.callee)
          ?.profile?.isEarner
          ? 0
          : Number(call.amountSpent),
        end_reason: call.endReason,
        ran_out_of_balance: call.endReason === 'insufficientBalance',
      },
    },
    'Call ended'
  );
}

/**
 * Lets a client that restarted mid-call rejoin instead of losing it.
 *
 * The credentials come with it, so "rejoin" means rejoining the *media*, not
 * just re-rendering a call screen over silence.
 */
async function getActive(req, res) {
  const call = await callService.getActive(req.userId);
  return ok(
    res,
    { call: call ? await callService.withMedia(call, req.userId) : null },
    call ? 'Call in progress' : 'No active call'
  );
}

async function history(req, res) {
  const params = q(req);
  const { skip, take } = toSkipTake(params);
  const { rows, total } = await callService.history(req.user, {
    direction: params.direction,
    skip,
    take,
  });
  return paginated(
    res,
    rows.map((c) => serialize.callRecord(c, req.userId)),
    { page: params.page, limit: params.limit, total }
  );
}

async function remove(req, res) {
  const result = await callService.deleteFromHistory(req.user, req.params.id);
  return ok(res, result, 'Removed from your history');
}

async function clearHistory(req, res) {
  const result = await callService.clearHistory(req.user);
  return ok(res, result, 'Call history cleared');
}

async function rate(req, res) {
  const call = await callService.rate(req.user, req.params.id, req.body.rating);
  return ok(res, { call_id: call.id, rating: call.rating }, 'Thanks for rating');
}

/**
 * The REST fallback for in-call chat — same as every other call action, for
 * whenever the socket cannot answer. See `sockets/index.js`'s `call:message`
 * for the path this actually runs on.
 */
async function sendMessage(req, res) {
  const message = await callService.sendMessage(req.user, req.params.id, req.body.text);
  return created(res, { message }, 'Sent');
}

module.exports = {
  start,
  accept,
  reject,
  cancel,
  end,
  token,
  getActive,
  history,
  remove,
  clearHistory,
  rate,
  sendMessage,
};
