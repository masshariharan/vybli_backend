'use strict';

const crypto = require('crypto');
const prisma = require('../config/prisma');
const { errors } = require('../utils/errors');
const relationship = require('./relationship.service');
const walletService = require('./wallet.service');
const notificationService = require('./notification.service');
const profileService = require('./profile.service');
const livekit = require('./livekit.service');
const activity = require('./activity.service');
const { emitToUser, emitToAdmin } = require('../sockets/bus');
const connections = require('../sockets/connections');
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

/**
 * How long the callee's phone has to confirm it is actually ringing.
 *
 * A socket can look connected for up to a ping cycle after its network died —
 * the phone in a lift, Wi-Fi gone. `call:incoming` then goes nowhere, and the
 * caller would sit on "Calling" for the whole ring timeout. A phone that is
 * really there acknowledges the ring (`call:ring_received`) within a second
 * or two; one that has not in this long cannot receive the call, and the
 * caller is told so rather than left waiting.
 */
const RING_ACK_TIMEOUT_MS = 10_000;

/** userId → the tail of that account's queued call actions. */
const callLocks = new Map();

/**
 * Runs `fn` once every earlier call action touching any of `userIds` has
 * finished, and holds later ones until it has.
 *
 * Each account's call actions run one at a time, in the order they
 * *arrived*. Without this, "hang up, then immediately call again" raced
 * itself: both socket events are handled concurrently, so `start`'s busy
 * check could read the Call table before `end` had written the old call
 * over. The old row still said `connected`, and the caller was told the
 * person they had just hung up on was "on another call".
 *
 * The queue position is taken synchronously, on the call itself, before
 * anything is awaited. That is what preserves arrival order: the socket
 * layer calls straight into these, so a `call:end` followed by a
 * `call:start` on one socket queues in that order.
 *
 * Code already holding a lock must never call another locked entry point
 * for the same account; it would wait on itself. `finalise` and the other
 * internals are unlocked for that reason, and only the exported entry points
 * and the timers take the lock.
 */
function withUserLocks(userIds, fn) {
  const keys = [...new Set(userIds.filter(Boolean))];
  const before = Promise.all(
    keys.map((key) => (callLocks.get(key) ?? Promise.resolve()).catch(() => {}))
  );
  const run = before.then(() => fn());
  const tail = run.then(
    () => {},
    () => {}
  );
  for (const key of keys) callLocks.set(key, tail);
  tail.then(() => {
    for (const key of keys) if (callLocks.get(key) === tail) callLocks.delete(key);
  });
  return run;
}

/** The same, for a call: both of its participants. */
async function withCallLock(callId, fn) {
  const row = await prisma.call.findUnique({
    where: { id: callId },
    select: { callerId: true, calleeId: true },
  });
  if (!row) return null;
  return withUserLocks([row.callerId, row.calleeId], fn);
}

/**
 * `${userId}:${clientId}` → the promise of the call that attempt created.
 *
 * Makes placing a call idempotent. The app sends `call:start` over the socket
 * and falls back to REST when no ack arrives in time. When the socket
 * attempt *had* succeeded and only its ack was lost, the retry used to place
 * a second call. That one was refused as busy ("on another call") because of
 * the first, while the first went on ringing the other phone for a call the
 * caller's screen had already given up on. A retry carrying the same client
 * id now gets the same call back.
 */
const recentStarts = new Map();
const START_DEDUPE_MS = 60_000;

/**
 * callId → this call's in-call chat, on this instance.
 *
 * Deliberately never touches Postgres. Every other message in this app is a
 * row because a chat is a thing people come back to — this is the opposite:
 * a note passed during one specific call, worth nothing the moment that call
 * is over, and a database row for it would be one more place a "temporary"
 * conversation quietly outlived the call it was tied to. Held only long
 * enough to hand a late joiner (a reconnect mid-call) what they missed, and
 * dropped the instant `finalise` closes the call out — see there.
 *
 * Same scaling note as `activeTimers`: in-process, so a multi-instance
 * deployment needs this behind a shared store too, keyed the same way.
 */
const messagesByCall = new Map();

/** However long a call's chat gets, only the most recent this many survive. */
const MAX_MESSAGES_PER_CALL = 200;

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
 *
 * Unambiguous for an earner/non-earner call, which is the only kind that is
 * billed. A same-side call — two accounts with "Show All Users" on, see
 * `relationship.canPair` — is placed at a rate of zero, so the fallback below
 * never actually moves money for it; it also keeps an in-flight call from
 * crashing if a profile's role changes mid-call.
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
function start(user, { userId: calleeId, type, isRandom = false, clientId } = {}) {
  const key = clientId ? `${user.id}:${clientId}` : null;
  if (key && recentStarts.has(key)) return recentStarts.get(key);

  // Nobody to ring, or nobody to ring *from* — answered instantly, from
  // memory, before any lock is queued or the database is asked anything. This
  // is the common refusal ("offline"), and it must not wait behind a slow
  // database to be said.
  if (calleeId !== user.id && !connections.isConnected(calleeId)) {
    return Promise.reject(errors.calleeOffline());
  }
  if (!connections.isConnected(user.id)) return Promise.reject(errors.callerOffline());

  const placing = withUserLocks([user.id, calleeId], () =>
    startUnlocked(user, { calleeId, type, isRandom })
  );
  if (key) {
    recentStarts.set(key, placing);
    // A refused attempt is not remembered: retrying it is a new decision.
    placing.catch(() => recentStarts.delete(key));
    setTimeout(() => recentStarts.delete(key), START_DEDUPE_MS).unref();
  }
  return placing;
}

async function startUnlocked(user, { calleeId, type, isRandom }) {
  // The callee first — reachable, online, not on another call (see
  // `relationship.assertCanCall`) — then the caller. All against the server's
  // own state: live sockets and the Call table, never a client's say-so.
  // A caller with no live socket would never hear "ringing", "answered" or
  // "ended" — and the callee would ring at a screen nobody is holding.
  if (!connections.isConnected(user.id)) throw errors.callerOffline();

  // Everything the decision needs, asked at once: the callee's checks (see
  // `relationship.assertCanCall` — reachable, allowed, not on another call),
  // whether the caller is already on one, and — for a caller who will pay —
  // their balance. Against a slow database these used to queue one behind
  // another for several seconds, long enough for the app to give up waiting.
  //
  // Neither side may already be on a call. Checked in the database rather than
  // from presence alone, because presence is a cache and this is the truth.
  // Run under both people's locks (see `start`), so two people calling each
  // other at the same instant cannot both get through: whichever lands second
  // sees the first call here.
  const callerMayPay = !user.profile?.isEarner;
  const [callee, , callerBalance] = await Promise.all([
    relationship.assertCanCall(user, calleeId, type),
    assertNotBusy(user.id, 'caller'),
    callerMayPay ? walletService.getBalance(user.id) : null,
  ]);

  // The rate is the earner's, not the callee's — an earner calling out still
  // sets the price, and the other side still pays it.
  //
  // A same-side call has no earner and no payer, so it is free: rate zero,
  // no balance check, and nothing for the per-minute billing to charge or the
  // bookkeeping to pay out (see `billOneMinute` and `finaliseBookkeeping`).
  // That is what lets "Show All Users" connect two people on the same side
  // without inventing a second billing model — the paid path below is exactly
  // the one every earner/non-earner call has always taken.
  const callerIsEarner = Boolean(user.profile?.isEarner);
  const sameSide = relationship.isSameSide(user, callee);
  const earnerProfile = callerIsEarner ? user.profile : callee.profile;
  const payerId = callerIsEarner ? calleeId : user.id;

  const ratePerMinute = sameSide
    ? 0
    : Number(
        type === 'voice'
          ? earnerProfile.voiceRatePerMinute
          : earnerProfile.videoRatePerMinute
      );

  if (ratePerMinute > 0 && payerId === user.id) {
    const balance = callerBalance ?? (await walletService.getBalance(payerId));
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
      ringDeliveredAt: null,
    },
    include: CALL_INCLUDE,
  });

  // Busy is set on both sides now, not on connect — a second caller must not
  // get through to a phone that is already ringing. (That rule is enforced by
  // `assertNotBusy` against the call rows; this is what everyone else sees.)
  //
  // Not awaited: nothing about placing the call depends on the stored presence
  // (busy is decided from the Call table), and each write is a database round
  // trip the caller would otherwise sit through before hearing "calling". The
  // writes are queued per person (see `syncPresence`), so a hang-up straight
  // after still lands after them.
  Promise.all([
    syncPresence(user.id, { onCall: true }),
    syncPresence(calleeId, { onCall: true }),
  ]).catch((err) => console.error(`[call] presence for call ${call.id}`, err));
  announceCallPresence(call, { callerStatus: 'busy', calleeStatus: 'busy' });

  // To every device the callee has open. Both sides get their join credentials
  // with the ring, so the callee's media is already connecting while the phone
  // is still buzzing — the difference between "hello?" and two seconds of
  // silence. There is no push fallback: a call only ever rings an app that is
  // open, and one that does not confirm it (below) ends as unavailable.
  emitToUser(calleeId, 'call:incoming', await withMedia(call, calleeId));
  // Always `calling` to begin with. `call:ringing` promises the caller their
  // ring actually landed on a device, and only the device can say that — it
  // acknowledges `call:incoming` with `call:ring_received`, and
  // `markRingDelivered` sends the real `call:ringing` then.
  emitToUser(user.id, 'call:calling', await withMedia(call, user.id));

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
  scheduleRingAckTimeout(call.id);

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

/**
 * The callee's device says the ring reached it — the socket's
 * `call:ring_received`, sent by the app the moment it shows the ring. This is
 * the only thing that turns the caller's "Calling" into "Ringing" — a socket
 * that merely *exists* is not a phone that rang — and the only thing that
 * keeps the ring alive past [RING_ACK_TIMEOUT_MS].
 *
 * Idempotent: every device may report the same ring, and only the first one
 * moves the caller's screen.
 * Anything that is not the callee, or not a call still ringing, is ignored
 * rather than refused — a late ack for a call that just ended is expected
 * traffic, not an error worth surfacing.
 */
async function markRingDelivered(user, callId) {
  if (typeof callId !== 'string' || !callId) return null;
  const { count } = await prisma.call.updateMany({
    where: { id: callId, calleeId: user.id, status: 'ringing', ringDeliveredAt: null },
    data: { ringDeliveredAt: new Date() },
  });
  if (count === 0) return null;

  const call = await loadCall(callId);
  emitToUser(call.callerId, 'call:ringing', await withMedia(call, call.callerId));
  return call;
}

/**
 * Ends a ring that can no longer reach anyone: the callee's last socket went,
 * or their phone never confirmed the ring ([RING_ACK_TIMEOUT_MS]).
 *
 * Calls are real-time only. There is no ringing somebody once they come back
 * online, so a ring nobody can hear is over now — `missed`, with the reason
 * `unavailable`, which the caller's app words as "offline and cannot receive
 * calls" — rather than left for the full ring timeout, pinning both people as
 * "on another call" to everyone else in the meantime.
 *
 * Under the call's lock, and only while it is still ringing: an answer that
 * got in first wins.
 */
function abandonRing(callId) {
  return withCallLock(callId, async () => {
    const call = await loadCall(callId).catch(() => null);
    if (!call || call.status !== 'ringing') return null;
    return finalise(call, { status: 'missed', reason: 'unavailable' });
  });
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

/** userId → the tail of that account's queued presence writes. */
const presenceQueue = new Map();

/**
 * Brings `userId`'s stored presence in line with what is actually true:
 * `offline` with no live socket, `busy` on a live call, `online` otherwise.
 *
 * Every automatic presence change goes through here — connect, disconnect, a
 * call starting or ending — and never writes a status it was merely *told*.
 * That is the fix for presence drifting from reality. It used to be written
 * piecemeal: a call ending set both sides `online` whether or not they had a
 * connection, and a disconnect wrote `offline` after an await, by which time
 * the same phone could already have reconnected and been marked online — so
 * the stale write landed last and the account sat "offline" while connected.
 *
 * Goes through `profileService.setPresence` because that is the only path
 * that tells everyone watching (chat peers, open profiles) about the change.
 *
 * Writes for one account are chained, so they land in the order they were
 * asked for, and each one reads the truth *when it runs*, not when it was
 * queued — the last write therefore always reflects the latest state.
 *
 * `onCall` lets a caller that already knows the answer (`start`, `finalise`)
 * skip the lookup — and in `finalise` it must, because the call row may not
 * read as over yet when this runs alongside that write.
 */
function syncPresence(userId, { onCall } = {}) {
  const previous = presenceQueue.get(userId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      if (!connections.isConnected(userId)) {
        return profileService.setPresence(userId, 'offline');
      }
      const busy = onCall ?? Boolean(await getActive(userId));
      return profileService.setPresence(userId, busy ? 'busy' : 'online');
    });
  presenceQueue.set(userId, next);
  next
    .finally(() => {
      if (presenceQueue.get(userId) === next) presenceQueue.delete(userId);
    })
    .catch(() => {});
  return next;
}

/**
 * Tells each side of a call about the other's presence directly.
 *
 * `profileService.setPresence` only announces to people with an *open
 * conversation* — right for chat, where that is the only surface showing
 * live presence, but two people on a call are exactly as entitled to know
 * about each other as two people mid-conversation, whether or not they have
 * ever exchanged a single message. Without this, a call between two people
 * who have only ever called each other left both sides' screens holding
 * whatever "busy"/"online" they last fetched — correct in the database,
 * stale on screen, sometimes indefinitely.
 *
 * Takes the privacy settings straight off the call row rather than querying
 * again — `start` and `finalise` both already load `caller`/`callee` with
 * `privacySettings` via `CALL_INCLUDE`.
 */
function announceCallPresence(call, { callerStatus, calleeStatus }) {
  const at = new Date().toISOString();
  const callerHidden = call.caller?.privacySettings?.showOnlineStatus === false;
  const calleeHidden = call.callee?.privacySettings?.showOnlineStatus === false;
  if (calleeStatus && !calleeHidden) {
    emitToUser(call.callerId, 'presence:changed', {
      user_id: call.calleeId,
      status: calleeStatus,
      last_seen: at,
    });
  }
  if (callerStatus && !callerHidden) {
    emitToUser(call.calleeId, 'presence:changed', {
      user_id: call.callerId,
      status: callerStatus,
      last_seen: at,
    });
  }
}

/**
 * Answers. Billing starts here, with the first minute.
 *
 * If that first charge fails — the caller spent their balance elsewhere
 * between dialling and being answered — the call ends immediately rather
 * than connecting for free.
 */
function accept(user, callId) {
  return withUserLocks([user.id], () => acceptUnlocked(user, callId));
}

async function acceptUnlocked(user, callId) {
  const call = await loadCall(callId);

  if (call.calleeId !== user.id) {
    throw errors.forbidden('That call is not yours to answer.', 'NOT_CALL_RECIPIENT');
  }
  if (call.status === 'connected') return call;
  if (call.status !== 'ringing') {
    throw errors.conflict('That call is no longer ringing.', 'CALL_NOT_RINGING');
  }

  clearTimers(callId);

  // The one thing that has to be known before anyone is told this call is
  // connected: whether it can be paid for at all. A plain read rather than
  // `billOneMinute`'s transaction — the actual charge still runs through
  // that, below, and its own atomic guard is what actually protects the
  // wallet; this is only here to keep the common case (the balance is fine)
  // from waiting on a transaction it is about to run anyway.
  const { payerId } = payerAndEarner(call);
  const rate = Number(call.ratePerMinute);
  const balance = await walletService.getBalance(payerId);
  if (rate > 0 && balance < rate) {
    await finalise(call, { status: 'ended', reason: 'insufficientBalance' });
    throw errors.insufficientBalance(rate, balance);
  }

  // Compare-and-set, like `finalise`: the caller may have hung up, or the
  // ring timed out, in the moment since this was read. Answering a call that
  // is already over must fail, not bring it back as `connected`.
  const { count } = await prisma.call.updateMany({
    where: { id: callId, status: 'ringing' },
    data: { status: 'connected', connectedAt: new Date() },
  });
  if (count === 0) {
    const now = await loadCall(callId);
    if (now.status === 'connected') return now;
    throw errors.conflict('That call is no longer ringing.', 'CALL_NOT_RINGING');
  }
  const connected = await loadCall(callId);

  // Fired the instant the row is written, not after the first minute is
  // actually charged — this is what makes *both* screens show "Connected",
  // and neither should sit through a wallet transaction and two more writes
  // first. `finalise`, above, makes the same trade for the same reason when
  // a call ends.
  emitToUser(connected.callerId, 'call:accepted', {
    call_id: callId,
    connected_at: connected.connectedAt.toISOString(),
  });
  emitToUser(connected.calleeId, 'call:connected', {
    call_id: callId,
    connected_at: connected.connectedAt.toISOString(),
  });
  emitToAdmin('admin:call_connected', {
    call_id: callId,
    type: connected.type,
    caller: { id: connected.callerId, name: connected.caller?.profile?.name ?? null },
    callee: { id: connected.calleeId, name: connected.callee?.profile?.name ?? null },
    at: connected.connectedAt.toISOString(),
  });

  // Everything past this point is the actual charge, the activity log and
  // starting the per-minute ticker — nobody's screen is waiting on any of
  // it, so it runs in the background instead of holding the response (and
  // the tap that triggered it) hostage to it. The balance check above
  // covers the common case; this is what still protects the wallet if it
  // changed in the instant between that read and this — a second call
  // answered in the same moment, say — the same way every other charge on
  // this call already does.
  billOneMinute(connected)
    .then((charged) => {
      if (!charged) {
        return finalise(connected, {
          status: 'ended',
          reason: 'insufficientBalance',
        });
      }
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
    })
    .catch((err) => console.error(`[call] background accept-billing failed for ${callId}`, err));

  return connected;
}

/** Declines a ringing call. */
function reject(user, callId) {
  return withUserLocks([user.id], () => rejectUnlocked(user, callId));
}

async function rejectUnlocked(user, callId) {
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
function cancel(user, callId) {
  return withUserLocks([user.id], () => cancelUnlocked(user, callId));
}

async function cancelUnlocked(user, callId) {
  const call = await loadCall(callId);
  if (call.callerId !== user.id) {
    throw errors.forbidden('That call is not yours to cancel.', 'NOT_CALL_CALLER');
  }
  // Answered in the same instant the caller hung up. The caller's app only
  // saw a ringing call and so asked to cancel, but the call is live now, and
  // refusing with "no longer ringing" left it connected: still billing, for
  // a caller whose screen already said it was over. Hanging up is what they
  // meant, so it ends.
  if (call.status === 'connected') {
    return finalise(call, { status: 'ended', reason: 'hungUp' });
  }
  if (call.status !== 'ringing') {
    throw errors.conflict('That call is no longer ringing.', 'CALL_NOT_RINGING');
  }
  const result = await finalise(call, { status: 'cancelled', reason: 'cancelled' });
  // Lost the race to an answer, as above: end what is now a live call.
  if (result.status === 'connected') {
    return finalise(result, { status: 'ended', reason: 'hungUp' });
  }
  return result;
}

/** Either side hanging up on a live call. */
function end(user, callId, options = {}) {
  return withUserLocks([user.id], () => endUnlocked(user, callId, options));
}

async function endUnlocked(user, callId, { reason = 'hungUp', force = false } = {}) {
  const call = await loadCall(callId);

  if (!force && call.callerId !== user.id && call.calleeId !== user.id) {
    throw errors.forbidden('That call is not yours.', 'NOT_CALL_PARTICIPANT');
  }
  // Anything no longer live is already over, however it ended. This only
  // listed `ended` and `missed`, so ending a call that had been *cancelled*
  // or *rejected* (both sides hanging up at once, or a retried request)
  // finalised it a second time. That rewrote it as `ended` and sent both
  // phones a second `call:ended`, which could arrive while the next call was
  // already up and close that one instead.
  if (call.status !== 'ringing' && call.status !== 'connected') return call;

  // Hanging up on a call that never connected is a cancel or a reject, not an
  // end — and it must not be billed.
  if (call.status === 'ringing') {
    const isCaller = call.callerId === user.id;
    const result = await finalise(call, {
      status: isCaller ? 'cancelled' : 'rejected',
      reason: isCaller ? 'cancelled' : 'rejected',
    });
    // Answered while this hang-up was on its way. Still a hang-up.
    if (result.status === 'connected') {
      return finalise(result, { status: 'ended', reason });
    }
    return result;
  }

  return finalise(call, { status: 'ended', reason });
}

// ── In-call chat ────────────────────────────────────────────────────────────
//
// A note passed during the call, not a conversation. See the doc on
// `messagesByCall` for why this never reaches Postgres.

/**
 * Sends one message on a live call.
 *
 * Only while `connected` — there is no video to talk over yet on a call
 * still ringing, and nothing left to reach once it has ended. Either side
 * may send; nothing here asks whether they have a conversation open, the same
 * as nothing asked before letting them talk over the call itself.
 */
async function sendMessage(user, callId, text) {
  const call = await loadCall(callId);
  if (call.callerId !== user.id && call.calleeId !== user.id) {
    throw errors.forbidden('That call is not yours.', 'NOT_CALL_PARTICIPANT');
  }
  if (call.status !== 'connected') {
    throw errors.conflict('That call is not connected.', 'CALL_NOT_CONNECTED');
  }

  const trimmed = (text ?? '').trim();
  if (!trimmed) throw errors.badRequest('Write a message');

  const message = {
    id: crypto.randomUUID(),
    call_id: callId,
    sender_id: user.id,
    text: trimmed,
    sent_at: new Date().toISOString(),
  };

  const thread = messagesByCall.get(callId) ?? [];
  thread.push(message);
  // Oldest first out — a call chat that ran long is worth its last couple of
  // hundred lines to a reconnecting client, not its first.
  if (thread.length > MAX_MESSAGES_PER_CALL) thread.shift();
  messagesByCall.set(callId, thread);

  const peerId = call.callerId === user.id ? call.calleeId : call.callerId;
  emitToUser(peerId, 'call:message', message);

  return message;
}

/** This call's chat so far, for a client that just (re)connected mid-call. */
function recentMessages(callId) {
  return messagesByCall.get(callId) ?? [];
}

/**
 * Closes a call out: duration, stats, earnings, notifications, presence.
 *
 * The one exit for every ending — hang-up, decline, timeout, out of balance — so
 * none of the bookkeeping can be attached to one path and missed on another.
 */
async function finalise(call, { status, reason }) {
  const endedAt = new Date();
  const durationSeconds = call.connectedAt
    ? Math.max(0, Math.floor((endedAt - new Date(call.connectedAt)) / 1000))
    : 0;

  // Compare-and-set: only a call still in the status this caller *read* can
  // be finished, and only once. Two endings race all the time: both people
  // hanging up together, a cancel landing as the callee answers, the ring
  // timeout firing as someone declines. With a plain update the loser
  // overwrote the winner, ran the whole ending a second time and sent both
  // phones a second `call:ended`. A late duplicate like that could reach an
  // app that had already started its next call. Whoever loses gets the call
  // as it now is, with no side effects, and decides from that.
  const { count } = await prisma.call.updateMany({
    where: { id: call.id, status: call.status },
    data: { status, endReason: reason, endedAt, durationSeconds },
  });
  if (count === 0) return loadCall(call.id);

  clearTimers(call.id);
  // The chat dies with the call — this is what actually makes it temporary,
  // rather than merely a client that stops rendering it. Dropped up front,
  // with the timers, rather than in the background bookkeeping below: there
  // is nothing to await, and no reason to let it outlive the call by even
  // the length of that background work.
  messagesByCall.delete(call.id);

  // The one write either side is actually waiting on. Whoever tapped End or
  // Decline is looking at that button right now, and the other party's
  // screen only moves once `call:ended` reaches them below — neither should
  // sit through a LiveKit REST call and four more database writes first,
  // and nothing downstream needs anything but this row.
  //
  // Presence is restored alongside it, not inside the background
  // bookkeeping below — freeing both people up to be called again is exactly
  // as urgent as the row saying the call is over. Restored to the *truth*,
  // not to `online`: someone whose connection died (the reason this call is
  // ending, often) or who was never connected at all (a missed call to a
  // phone that was off) comes out of it `offline`. Writing `online` for both
  // unconditionally is what left people advertised as online with their
  // phone switched off.
  const statusOf = (id) => (connections.isConnected(id) ? 'online' : 'offline');
  const [updated] = await Promise.all([
    loadCall(call.id),
    Promise.all([
      syncPresence(call.callerId, { onCall: false }),
      syncPresence(call.calleeId, { onCall: false }),
    ]).catch((err) => {
      console.error(`[call] presence reset failed for ${call.id}`, err);
    }),
  ]);

  // See `announceCallPresence` — this is what actually moves a stale "Busy"
  // on the other side's screen the instant the call ends, rather than
  // leaving it to whatever next re-fetches that profile.
  announceCallPresence(updated, {
    callerStatus: statusOf(call.callerId),
    calleeStatus: statusOf(call.calleeId),
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
  // closing the LiveKit room, the lifetime-call count, the earner's credit, a
  // missed-call notification, the activity log, and the admin feed. None of
  // it needs to finish before either app hears "the call is over" — that
  // already happened above — so it runs in the background instead of holding
  // the response (and, for `end`/`reject`, the person's tap) hostage to it.
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
  // Presence is already restored — `finalise` synced it up front,
  // alongside the row write, because that is the one piece of this cleanup
  // urgent enough not to be fire-and-forget. Everything below genuinely is.
  const writes = [livekit.closeRoom(call.id)];

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
function onMediaDisconnect(callId, { reason = 'networkError' } = {}) {
  return withCallLock(callId, async () => {
    const call = await prisma.call.findUnique({
      where: { id: callId },
      include: CALL_INCLUDE,
    });
    if (!call || call.status !== 'connected') return null;
    return finalise(call, { status: 'ended', reason });
  });
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
  // A free call — see `startUnlocked`. Nothing to take, and nothing worth a
  // `wallet:updated` or a ₹0 `call:charged` every minute.
  if (!(rate > 0)) return true;
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
        await withCallLock(call.id, async () => {
          const still = await loadCall(call.id).catch(() => null);
          if (still?.status !== 'connected') return;
          await finalise(still, { status: 'ended', reason: 'insufficientBalance' });
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
      await withCallLock(callId, async () => {
        const call = await loadCall(callId).catch(() => null);
        if (!call || call.status !== 'ringing') return;
        await finalise(call, { status: 'missed', reason: 'missed' });
      });
    } catch (err) {
      console.error(`[call] ring timeout failed for ${callId}`, err);
    }
  }, RING_TIMEOUT_MS);

  activeTimers.set(callId, { ...(activeTimers.get(callId) ?? {}), timeout });
}

/** A ring the callee's phone never confirmed — see [RING_ACK_TIMEOUT_MS]. */
function scheduleRingAckTimeout(callId) {
  const ackTimeout = setTimeout(async () => {
    try {
      const call = await prisma.call.findUnique({
        where: { id: callId },
        select: { status: true, ringDeliveredAt: true },
      });
      if (call?.status === 'ringing' && !call.ringDeliveredAt) {
        await abandonRing(callId);
      }
    } catch (err) {
      console.error(`[call] ring-ack check failed for ${callId}`, err);
    }
  }, RING_ACK_TIMEOUT_MS);
  ackTimeout.unref?.();

  activeTimers.set(callId, { ...(activeTimers.get(callId) ?? {}), ackTimeout });
}

function clearTimers(callId) {
  const timers = activeTimers.get(callId);
  if (!timers) return;
  if (timers.interval) clearInterval(timers.interval);
  if (timers.timeout) clearTimeout(timers.timeout);
  if (timers.ackTimeout) clearTimeout(timers.ackTimeout);
  activeTimers.delete(callId);
}

/**
 * How long a `ringing` row is given before the sweep below gives up on it.
 * Padded past `RING_TIMEOUT_MS` on purpose — [scheduleRingTimeout] is the
 * mechanism that is *supposed* to close an unanswered call, and this only
 * exists for the times that timer never got the chance to fire.
 */
const STALE_RINGING_MS = RING_TIMEOUT_MS + 30_000;

/**
 * How long a `connected` row is left before the sweep decides nobody is
 * actually still on it. Deliberately generous — a real call can run for
 * hours — because this is a last-resort backstop, not the thing that is
 * meant to end a call: `handleDisconnect`, the LiveKit webhook and the
 * billing ticker's own `status !== 'connected'` check all close a call long
 * before this would ever see one.
 */
const STALE_CONNECTED_MS = 4 * 60 * 60 * 1000;

/**
 * Finds and closes out calls that never got the finalising write that was
 * supposed to end them, and re-checks it on a timer — see [scheduleSweeps].
 *
 * `scheduleRingTimeout`, `startBilling`'s own status check, the socket
 * disconnect handler and `reconcileOnBoot` all exist to make sure a call's
 * row always ends up saying what actually happened to it. All four are
 * in-process or event-driven, though, and everything in-process is gone the
 * moment the process is: a call whose finalising write itself failed (a
 * transient database error between `clearTimers` and the write it was
 * guarding), or one whose timer was silently dropped by something other
 * than a clean restart, is left `ringing` or `connected` forever with
 * nothing left watching it — which reads to the next caller as "busy",
 * indefinitely, for someone who is not on any call at all.
 *
 * This is what makes that self-heal within a bounded time regardless of how
 * the row got stuck, rather than staying wrong until the process happens to
 * restart.
 */
async function sweepStaleCalls() {
  const now = Date.now();
  const stale = await prisma.call.findMany({
    where: {
      OR: [
        { status: 'ringing', startedAt: { lt: new Date(now - STALE_RINGING_MS) } },
        { status: 'connected', connectedAt: { lt: new Date(now - STALE_CONNECTED_MS) } },
      ],
    },
    include: CALL_INCLUDE,
  });

  for (const call of stale) {
    await finalise(call, {
      status: call.status === 'connected' ? 'ended' : 'missed',
      reason: 'networkError',
    }).catch((err) => console.error(`[call] stale sweep failed for ${call.id}`, err));
  }

  return stale.length;
}

/** Runs [sweepStaleCalls] on a timer for the life of the process. */
function scheduleSweeps() {
  const timer = setInterval(() => {
    sweepStaleCalls()
      .then((n) => {
        if (n > 0) console.info(`[call] sweep closed ${n} stale call(s)`);
      })
      .catch((err) => console.error('[call] stale sweep failed', err));
    // Unrefed so a lone pending sweep never keeps the process alive on its own.
  }, 60_000).unref();
  return timer;
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
  markRingDelivered,
  abandonRing,
  syncPresence,
  onMediaDisconnect,
  sendMessage,
  recentMessages,
  loadCall,
  reconcileOnBoot,
  sweepStaleCalls,
  scheduleSweeps,
  clearTimers,
  CALL_INCLUDE,
};
