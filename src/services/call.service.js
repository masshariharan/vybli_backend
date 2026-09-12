'use strict';

const prisma = require('../config/prisma');
const { errors } = require('../utils/errors');
const relationship = require('./relationship.service');
const walletService = require('./wallet.service');
const notificationService = require('./notification.service');
const livekit = require('./livekit.service');
const activity = require('./activity.service');
const { emitToUser, emitToAdmin } = require('../sockets/bus');
const serialize = require('../utils/serialize');

/**
 * Calls, and the money they move.
 *
 * The billing model matches what every screen in the app promises: a call is
 * charged **at the start of each minute**, minute one landing the moment it
 * connects. So a 10-second call costs one minute and a 61-second call costs
 * two — which is what "₹12 per minute" means to someone reading it on a
 * card.
 *
 * Billing runs on the **server's** clock, in [startBilling]. A client that is
 * killed mid-call, or one that lies about the duration, changes nothing: the
 * ticker keeps charging until the call is ended or the wallet runs dry.
 *
 * Scaling note: the tickers are in-process, so a multi-instance deployment
 * needs them moved behind a shared store (Redis keyspace notifications, or a
 * job queue keyed on call id). Everything else here is already stateless.
 */

/** callId → { interval, timeout } for calls live on this instance. */
const activeTimers = new Map();

/** Unanswered calls give up after this long and become missed. */
const RING_TIMEOUT_MS = 45_000;

const USER_INCLUDE = {
  profile: true,
  privacySettings: true,
};

const CALL_INCLUDE = {
  caller: { include: USER_INCLUDE },
  callee: { include: USER_INCLUDE },
};

/**
 * Who pays and who earns on this call — a role, not a caller/callee position.
 * `assertCanCall` only lets an earner and a non-earner ring each other, so
 * this is unambiguous for any call actually placed through this service; the
 * same-role fallback exists only so an in-flight call cannot crash if a
 * profile's role changes mid-call.
 */
function payerAndEarner(call) {
  const callerIsEarner = Boolean(call.caller?.profile?.isEarner);
  const calleeIsEarner = Boolean(call.callee?.profile?.isEarner);
  if (callerIsEarner === calleeIsEarner) {
    return { payerId: call.callerId, earnerId: calleeIsEarner ? call.calleeId : null };
  }
  return callerIsEarner
    ? { payerId: call.calleeId, earnerId: call.callerId }
    : { payerId: call.callerId, earnerId: call.calleeId };
}

/**
 * Places a call.
 *
 * The balance is only checked here when the *caller* is the one about to
 * pay — a self-check against your own wallet before you dial. When an
 * earner calls out, the other side pays, and their balance is theirs to
 * know: the call rings regardless, and the check that matters happens where
 * it belongs, in `accept`, charged to and reported to whoever is actually
 * answering. Blocking the call here instead would tell a caller a stranger's
 * balance and deny her a ring that might have connected — someone can go
 * top up between a ring and an answer, or answer a call priced within
 * whatever they already have.
 */
async function start(user, { userId: calleeId, type, isRandom = false }) {
  const callee = await relationship.assertCanCall(user, calleeId, type);

  // Neither side may already be on a call. Checked in the database rather than
  // from presence alone, because presence is a cache and this is the truth.
  await assertNotBusy(user.id, 'caller');
  await assertNotBusy(calleeId, 'callee');

  // The rate is the earner's, not the callee's — an earner calling out still
  // sets the price, and the other side still pays it.
  const callerIsEarner = Boolean(user.profile?.isEarner);
  const earnerProfile = callerIsEarner ? user.profile : callee.profile;
  const payerId = callerIsEarner ? calleeId : user.id;

  const ratePerMinute = Number(
    type === 'voice'
      ? earnerProfile.voiceRatePerMinute
      : earnerProfile.videoRatePerMinute
  );

  if (payerId === user.id) {
    const balance = await walletService.getBalance(payerId);
    if (balance < ratePerMinute) throw errors.insufficientBalance(ratePerMinute, balance);
  }

  const call = await prisma.call.create({
    data: {
      callerId: user.id,
      calleeId,
      type,
      status: 'ringing',
      isRandom,
      ratePerMinute,
    },
    include: CALL_INCLUDE,
  });

  // Busy is set on both sides now, not on connect — a second caller must not
  // get through to a phone that is already ringing.
  await setPresence([user.id, calleeId], 'busy');

  // Both sides get their join credentials with the ring, so the callee's media
  // is already connecting while the phone is still buzzing. Waiting until they
  // tap Answer to fetch a token is the difference between "hello?" and two
  // seconds of silence.
  emitToUser(calleeId, 'call:incoming', await withMedia(call, calleeId));
  emitToUser(user.id, 'call:ringing', await withMedia(call, user.id));

  activity.recordPair(
    {
      userId: user.id,
      type: 'call_started',
      relatedUserId: calleeId,
      relatedEntityId: call.id,
      description: `Placed a ${type} call to ${activity.nameOf(callee)}`,
      status: 'ringing',
      metadata: { direction: 'outgoing', type, rate_per_minute: ratePerMinute },
    },
    {
      userId: calleeId,
      type: 'call_started',
      relatedUserId: user.id,
      relatedEntityId: call.id,
      description: `Incoming ${type} call from ${activity.nameOf(user)}`,
      status: 'ringing',
      metadata: { direction: 'incoming', type, rate_per_minute: ratePerMinute },
    }
  );

  emitToAdmin('admin:call_started', {
    call_id: call.id,
    type,
    caller: { id: user.id, name: user.profile?.name ?? null },
    callee: { id: calleeId, name: callee.profile?.name ?? null },
    at: new Date().toISOString(),
  });

  scheduleRingTimeout(call.id);

  return call;
}

/**
 * The serialized call, plus **this viewer's** media credentials.
 *
 * Every route and every push that hands a call to a client goes through here,
 * so a client can never end up holding a call it cannot join. The token is
 * per-viewer and per-room, so this cannot be computed once and broadcast —
 * the caller's token would let the callee publish as the caller.
 *
 * A finished call carries no credentials: there is nothing left to join, and
 * issuing a token for a closed room would only invite a client to try.
 */
async function withMedia(call, viewerId) {
  const payload = serialize.activeCall(call, viewerId);
  const live = call.status === 'ringing' || call.status === 'connected';
  if (!live) {
    payload.livekit = null;
    return payload;
  }

  const viewer = call.callerId === viewerId ? call.caller : call.callee;
  payload.livekit = await livekit.issueToken({
    call,
    userId: viewerId,
    displayName: viewer?.profile?.name,
  });
  return payload;
}

async function assertNotBusy(userId, role) {
  const live = await prisma.call.findFirst({
    where: {
      status: { in: ['ringing', 'connected'] },
      OR: [{ callerId: userId }, { calleeId: userId }],
    },
    select: { id: true },
  });
  if (live) throw role === 'caller' ? errors.callerBusy() : errors.calleeBusy();
}

function setPresence(userIds, presence) {
  return prisma.userProfile.updateMany({
    where: { userId: { in: userIds } },
    data: { presence },
  });
}

/**
 * Answers. Billing starts here, with the first minute.
 *
 * If that first charge fails — the caller spent their balance elsewhere
 * between dialling and being answered — the call ends immediately rather
 * than connecting for free.
 */
async function accept(user, callId) {
  const call = await loadCall(callId);

  if (call.calleeId !== user.id) {
    throw errors.forbidden('That call is not yours to answer.', 'NOT_CALL_RECIPIENT');
  }
  if (call.status === 'connected') return call;
  if (call.status !== 'ringing') {
    throw errors.conflict('That call is no longer ringing.', 'CALL_NOT_RINGING');
  }

  clearTimers(callId);

  const connected = await prisma.call.update({
    where: { id: callId },
    data: { status: 'connected', connectedAt: new Date() },
    include: CALL_INCLUDE,
  });

  const charged = await billOneMinute(connected);
  if (!charged) {
    await end(user, callId, { reason: 'insufficientBalance', force: true });
    throw errors.insufficientBalance(Number(connected.ratePerMinute), 0);
  }

  emitToUser(connected.callerId, 'call:accepted', {
    call_id: callId,
    connected_at: connected.connectedAt.toISOString(),
  });
  emitToUser(connected.calleeId, 'call:connected', {
    call_id: callId,
    connected_at: connected.connectedAt.toISOString(),
  });

  activity.recordPair(
    {
      userId: connected.calleeId,
      type: 'call_accepted',
      relatedUserId: connected.callerId,
      relatedEntityId: callId,
      description: `Answered a ${connected.type} call from ${activity.nameOf(connected.caller)}`,
      status: 'connected',
    },
    {
      userId: connected.callerId,
      type: 'call_accepted',
      relatedUserId: connected.calleeId,
      relatedEntityId: callId,
      description: `${activity.nameOf(connected.callee)} answered`,
      status: 'connected',
    }
  );

  startBilling(connected);
  return connected;
}

/** Declines a ringing call. */
async function reject(user, callId) {
  const call = await loadCall(callId);
  if (call.calleeId !== user.id) {
    throw errors.forbidden('That call is not yours to decline.', 'NOT_CALL_RECIPIENT');
  }
  if (call.status !== 'ringing') {
    throw errors.conflict('That call is no longer ringing.', 'CALL_NOT_RINGING');
  }
  return finalise(call, { status: 'rejected', reason: 'rejected' });
}

/** The caller hanging up before it is answered. */
async function cancel(user, callId) {
  const call = await loadCall(callId);
  if (call.callerId !== user.id) {
    throw errors.forbidden('That call is not yours to cancel.', 'NOT_CALL_CALLER');
  }
  if (call.status !== 'ringing') {
    throw errors.conflict('That call is no longer ringing.', 'CALL_NOT_RINGING');
  }
  return finalise(call, { status: 'cancelled', reason: 'cancelled' });
}

/** Either side hanging up on a live call. */
async function end(user, callId, { reason = 'hungUp', force = false } = {}) {
  const call = await loadCall(callId);

  if (!force && call.callerId !== user.id && call.calleeId !== user.id) {
    throw errors.forbidden('That call is not yours.', 'NOT_CALL_PARTICIPANT');
  }
  if (call.status === 'ended' || call.status === 'missed') return call;

  // Hanging up on a call that never connected is a cancel or a reject, not an
  // end — and it must not be billed.
  if (call.status === 'ringing') {
    const isCaller = call.callerId === user.id;
    return finalise(call, {
      status: isCaller ? 'cancelled' : 'rejected',
      reason: isCaller ? 'cancelled' : 'rejected',
    });
  }

  return finalise(call, { status: 'ended', reason });
}

/**
 * Closes a call out: duration, stats, earnings, notifications, presence.
 *
 * The one exit for every ending — hang-up, decline, timeout, out of balance — so
 * none of the bookkeeping can be attached to one path and missed on another.
 */
async function finalise(call, { status, reason }) {
  clearTimers(call.id);

  const endedAt = new Date();
  const durationSeconds = call.connectedAt
    ? Math.max(0, Math.floor((endedAt - new Date(call.connectedAt)) / 1000))
    : 0;

  // The one write either side is actually waiting on. Whoever tapped End or
  // Decline is looking at that button right now, and the other party's
  // screen only moves once `call:ended` reaches them below — neither should
  // sit through a LiveKit REST call and four more database writes first,
  // and nothing downstream needs anything but this row.
  const updated = await prisma.call.update({
    where: { id: call.id },
    data: { status, endReason: reason, endedAt, durationSeconds },
    include: CALL_INCLUDE,
  });

  // Fired the instant the row is written, not after the bookkeeping below —
  // this is what makes the *other* person's screen react, and they should
  // not be waiting on somebody else's earnings ledger to find out the call
  // is over. `emitToUser` only queues onto the in-process event bus, so
  // this returns immediately either way.
  const payload = {
    call_id: call.id,
    status,
    end_reason: reason,
    duration_seconds: durationSeconds,
    amount_spent: Number(updated.amountSpent),
  };
  emitToUser(call.callerId, 'call:ended', payload);
  emitToUser(call.calleeId, 'call:ended', payload);

  // Everything past this point is bookkeeping nobody's screen is waiting on:
  // closing the LiveKit room, resetting presence, the lifetime-call count,
  // the earner's credit, a missed-call notification, the activity log, and
  // the admin feed. None of it needs to finish before either app hears "the
  // call is over" — that already happened above — so it runs in the
  // background instead of holding the response (and, for `end`/`reject`, the
  // person's tap) hostage to it.
  //
  // A failure here is logged, not thrown: the call has already ended in the
  // database, and turning a bookkeeping error into a failed hang-up would be
  // strictly worse than a gap in the ledger.
  finaliseBookkeeping(call, updated, { status, reason, durationSeconds }).catch(
    (err) => console.error(`[call] background finalise failed for ${call.id}`, err)
  );

  return updated;
}

async function finaliseBookkeeping(call, updated, { status, reason, durationSeconds }) {
  const writes = [
    livekit.closeRoom(call.id),
    setPresence([call.callerId, call.calleeId], 'online'),
  ];

  // Keyed on **what was charged**, not on elapsed time. Billing is per started
  // minute, so a five-second call still costs the caller a full minute — and
  // paying the earner nothing for it would mean money leaving one wallet and
  // arriving in none.
  if (status === 'ended' && Number(updated.amountSpent) > 0) {
    // Only connected calls count towards the "total calls" on a profile.
    writes.push(
      prisma.userProfile.updateMany({
        where: { userId: { in: [call.callerId, call.calleeId] } },
        data: { totalCalls: { increment: 1 } },
      })
    );

    const { earnerId } = payerAndEarner(updated);
    if (earnerId) {
      writes.push(
        walletService
          .recordEarning({
            userId: earnerId,
            callId: call.id,
            amountSpent: Number(updated.amountSpent),
            // At least one — money was charged, so at least one minute was
            // billed, whatever rounding says.
            minutes: Math.max(1, billedMinutes(updated)),
          })
          .then(() => emitToUser(earnerId, 'wallet:updated', {}))
      );
    }
  }

  if (status === 'missed') {
    writes.push(
      notificationService.notify({
        userId: call.calleeId,
        kind: 'missedCall',
        title: `Missed ${call.type} call`,
        body: `from ${updated.caller.profile?.name ?? 'someone'}`,
        data: { call_id: call.id, user_id: call.callerId },
      })
    );
  }

  await Promise.all(writes);

  // One row per participant, phrased from each side. `missed` is the case
  // that matters most in support: the callee needs it on their timeline even
  // though they did nothing.
  const minutes = Math.round(durationSeconds / 60);
  const shared = {
    relatedEntityId: call.id,
    status,
    metadata: {
      type: call.type,
      duration_seconds: durationSeconds,
      amount_spent: Number(updated.amountSpent),
      end_reason: reason,
    },
  };
  const spoken = durationSeconds
    ? ` — ${minutes >= 1 ? `${minutes} min` : `${durationSeconds}s`}`
    : '';

  activity.recordPair(
    {
      ...shared,
      userId: call.callerId,
      type: status === 'missed' ? 'call_missed' : 'call_ended',
      relatedUserId: call.calleeId,
      description:
        status === 'missed'
          ? `${activity.nameOf(updated.callee)} did not answer`
          : `${call.type === 'voice' ? 'Voice' : 'Video'} call with ${activity.nameOf(updated.callee)} ended${spoken}`,
    },
    {
      ...shared,
      userId: call.calleeId,
      type: status === 'missed' ? 'call_missed' : 'call_ended',
      relatedUserId: call.callerId,
      description:
        status === 'missed'
          ? `Missed a ${call.type} call from ${activity.nameOf(updated.caller)}`
          : `${call.type === 'voice' ? 'Voice' : 'Video'} call with ${activity.nameOf(updated.caller)} ended${spoken}`,
    }
  );

  emitToAdmin('admin:call_ended', {
    call_id: call.id,
    status,
    end_reason: reason,
    duration_seconds: durationSeconds,
    amount_spent: Number(updated.amountSpent),
    type: call.type,
    caller: { id: call.callerId, name: updated.caller.profile?.name ?? null },
    callee: { id: call.calleeId, name: updated.callee.profile?.name ?? null },
  });
}

/**
 * A participant's media session dropped, per LiveKit's webhook.
 *
 * This is the case a hang-up button cannot cover: the phone lost signal, the
 * battery died, the app was force-stopped. Nothing tells the API — the socket
 * may take a minute to notice, and the billing ticker would happily keep
 * charging a caller whose phone is face-down and dead.
 *
 * A **connected** call whose room has lost a participant is over. A *ringing*
 * one is not: neither side has joined the room yet, and the ring timeout is
 * the right authority there.
 *
 * `networkError` rather than `hungUp`, because the summary should say what
 * actually happened — and because the two want different copy on the screen.
 */
async function onMediaDisconnect(callId, { reason = 'networkError' } = {}) {
  const call = await prisma.call.findUnique({
    where: { id: callId },
    include: CALL_INCLUDE,
  });
  if (!call || call.status !== 'connected') return null;
  return finalise(call, { status: 'ended', reason });
}

/** How many minutes were charged — amount spent divided by the snapshotted rate. */
function billedMinutes(call) {
  const rate = Number(call.ratePerMinute);
  if (!rate) return 0;
  return Math.round(Number(call.amountSpent) / rate);
}

// ── Billing ─────────────────────────────────────────────────────────────────

/**
 * Charges one minute. Returns false when the wallet cannot cover it.
 *
 * `amountSpent` accumulates what was actually taken rather than being derived
 * from the clock, so the summary and the balance are the same number by
 * construction.
 */
async function billOneMinute(call) {
  const { payerId } = payerAndEarner(call);
  const rate = Number(call.ratePerMinute);
  try {
    let spent = Number(call.amountSpent) + rate;
    await prisma.$transaction(async (tx) => {
      await walletService.spend({
        userId: payerId,
        amount: rate,
        title: `${call.type === 'voice' ? 'Voice' : 'Video'} call`,
        subtitle: `with ${(payerId === call.callerId ? call.callee : call.caller)?.profile?.name ?? 'a user'}`,
        referenceId: call.id,
        tx,
      });
      const updated = await tx.call.update({
        where: { id: call.id },
        data: { amountSpent: { increment: rate } },
      });
      spent = Number(updated.amountSpent);
    });

    const balance = await walletService.getBalance(payerId);
    emitToUser(payerId, 'wallet:updated', { balance });

    // The running cost, so the pill on the call screen keeps up. Sent as a
    // total rather than a delta: a client that misses one packet would
    // otherwise under-report the charge for the rest of the call.
    emitToUser(payerId, 'call:charged', {
      call_id: call.id,
      amount_spent: spent,
    });

    // Warn while there is still a minute left to warn during, so the call
    // cutting out is never a surprise.
    if (balance < rate) {
      emitToUser(payerId, 'call:low_balance', {
        call_id: call.id,
        balance,
        rate_per_minute: rate,
      });
    }
    return true;
  } catch (err) {
    if (err.code === 'INSUFFICIENT_BALANCE') return false;
    throw err;
  }
}

/**
 * Runs the per-minute charge for a connected call.
 *
 * Minute one is already paid by the caller of this function, so the interval
 * starts at the 60-second boundary.
 */
function startBilling(call) {
  clearTimers(call.id);

  const interval = setInterval(async () => {
    try {
      const current = await prisma.call.findUnique({
        where: { id: call.id },
        include: CALL_INCLUDE,
      });
      // Ended by either side between ticks.
      if (!current || current.status !== 'connected') {
        clearTimers(call.id);
        return;
      }

      const charged = await billOneMinute(current);
      if (!charged) {
        await finalise(current, {
          status: 'ended',
          reason: 'insufficientBalance',
        });
      }
    } catch (err) {
      console.error(`[call] billing failed for ${call.id}`, err);
      clearTimers(call.id);
    }
  }, 60_000);

  activeTimers.set(call.id, { ...(activeTimers.get(call.id) ?? {}), interval });
}

/** Unanswered calls become missed rather than ringing forever. */
function scheduleRingTimeout(callId) {
  const timeout = setTimeout(async () => {
    try {
      const call = await loadCall(callId).catch(() => null);
      if (!call || call.status !== 'ringing') return;
      await finalise(call, { status: 'missed', reason: 'missed' });
    } catch (err) {
      console.error(`[call] ring timeout failed for ${callId}`, err);
    }
  }, RING_TIMEOUT_MS);

  activeTimers.set(callId, { ...(activeTimers.get(callId) ?? {}), timeout });
}

function clearTimers(callId) {
  const timers = activeTimers.get(callId);
  if (!timers) return;
  if (timers.interval) clearInterval(timers.interval);
  if (timers.timeout) clearTimeout(timers.timeout);
  activeTimers.delete(callId);
}

// ── Reads ───────────────────────────────────────────────────────────────────

async function loadCall(callId) {
  const call = await prisma.call.findUnique({
    where: { id: callId },
    include: CALL_INCLUDE,
  });
  if (!call) throw errors.notFound('Call', 'CALL_NOT_FOUND');
  return call;
}

/** The call in progress for this user, if any — for resuming after a reload. */
function getActive(userId) {
  return prisma.call.findFirst({
    where: {
      status: { in: ['ringing', 'connected'] },
      OR: [{ callerId: userId }, { calleeId: userId }],
    },
    include: CALL_INCLUDE,
    orderBy: { createdAt: 'desc' },
  });
}

/** The Recent tab. */
async function history(user, { direction, skip, take }) {
  const base = { OR: [{ callerId: user.id }, { calleeId: user.id }] };
  let where = base;

  if (direction === 'outgoing') where = { callerId: user.id };
  else if (direction === 'incoming') {
    where = { calleeId: user.id, status: { not: 'missed' } };
  } else if (direction === 'missed') {
    where = { calleeId: user.id, status: 'missed' };
  }

  // A call still ringing is not history yet.
  where = { AND: [where, { status: { notIn: ['ringing'] } }] };

  const [rows, total] = await Promise.all([
    prisma.call.findMany({
      where,
      include: { ...CALL_INCLUDE, earning: true },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.call.count({ where }),
  ]);

  return { rows, total };
}

async function deleteFromHistory(user, callId) {
  const call = await loadCall(callId);
  if (call.callerId !== user.id && call.calleeId !== user.id) {
    throw errors.notFound('Call', 'CALL_NOT_FOUND');
  }
  if (call.status === 'ringing' || call.status === 'connected') {
    throw errors.conflict('That call is still in progress.', 'CALL_IN_PROGRESS');
  }
  // Hard delete: the ledger and any earning row keep the financial record, so
  // clearing your call log costs no accounting.
  await prisma.call.delete({ where: { id: callId } });
  return { deleted: true };
}

async function clearHistory(user) {
  const { count } = await prisma.call.deleteMany({
    where: {
      status: { notIn: ['ringing', 'connected'] },
      OR: [{ callerId: user.id }, { calleeId: user.id }],
    },
  });
  return { deleted: count };
}

/**
 * Rates a finished call.
 *
 * The rating goes onto the call *and* recomputes the callee's average from
 * scratch, rather than nudging a running figure that would drift.
 */
async function rate(user, callId, rating) {
  const call = await loadCall(callId);
  if (call.callerId !== user.id) {
    throw errors.forbidden('Only the caller can rate a call.', 'NOT_CALL_CALLER');
  }
  if (call.status !== 'ended') {
    throw errors.conflict('That call has not finished.', 'CALL_NOT_ENDED');
  }

  const updated = await prisma.call.update({
    where: { id: callId },
    data: { rating },
    include: CALL_INCLUDE,
  });

  const stats = await prisma.call.aggregate({
    where: { calleeId: call.calleeId, rating: { not: null } },
    _avg: { rating: true },
    _count: { rating: true },
  });

  await prisma.userProfile.update({
    where: { userId: call.calleeId },
    data: {
      rating: Number((stats._avg.rating ?? 0).toFixed(2)),
      ratedCalls: stats._count.rating,
    },
  });

  return updated;
}

/** Ends every live call at boot — a crash leaves rows stuck at `connected`. */
async function reconcileOnBoot() {
  const stuck = await prisma.call.findMany({
    where: { status: { in: ['ringing', 'connected'] } },
    include: CALL_INCLUDE,
  });
  for (const call of stuck) {
    await finalise(call, {
      status: call.connectedAt ? 'ended' : 'missed',
      reason: 'networkError',
    }).catch(() => {});
  }
  return stuck.length;
}

module.exports = {
  start,
  accept,
  reject,
  cancel,
  end,
  history,
  deleteFromHistory,
  clearHistory,
  rate,
  getActive,
  withMedia,
  onMediaDisconnect,
  loadCall,
  reconcileOnBoot,
  clearTimers,
  CALL_INCLUDE,
};
