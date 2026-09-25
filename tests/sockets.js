'use strict';

/**
 * Socket.IO end-to-end.
 *
 *   node src/server.js        # terminal one
 *   node tests/sockets.js     # terminal two
 *
 * The REST suite cannot reach any of this: presence only means something while
 * a connection is open, and delivery is the whole point of a push. So this
 * drives two real clients and asserts that what one does arrives at the other.
 */

const { io } = require('socket.io-client');

const BASE = process.env.API_BASE || 'http://localhost:4000/api/v1';
const SOCKET_URL = process.env.SOCKET_URL || 'http://localhost:4000';

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    failures.push({ label, detail });
    console.log(`  ✗ ${label}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`);
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

/** Every number this run created, so it can remove them again. */
const createdPhones = [];

/**
 * Deletes every account this run created.
 *
 * Straight to the database rather than through `DELETE /auth/account`: that
 * endpoint anonymises and tombstones by design, which is right for a person
 * leaving and wrong for a fixture — it would leave the same rows behind under
 * a different name.
 *
 * A suite that leaves its accounts behind turns a development database into a
 * discovery feed full of people who do not exist, one run at a time.
 */
async function removeCreatedAccounts() {
  if (createdPhones.length === 0) return 0;
  const { createPrismaClient } = require('../src/config/prismaClient');
  const prisma = createPrismaClient();
  try {
    const rows = await prisma.user.findMany({
      where: { OR: createdPhones.map((phone) => ({ phone: { contains: phone } })) },
      select: { id: true },
    });
    if (rows.length === 0) return 0;
    const ids = rows.map((r) => r.id);

    // `Conversation`, `Message` and `Call` hold their user relations as
    // `onDelete: Restrict` on purpose, so a real account deletion never
    // cascades into someone else's chat or call history. A fixture is not a
    // real account, though, and this run's whole point is to leave nothing
    // behind, so its dependants are cleared explicitly first.
    await prisma.$transaction([
      prisma.message.deleteMany({
        where: {
          OR: [
            { senderId: { in: ids } },
            { conversation: { OR: [{ userAId: { in: ids } }, { userBId: { in: ids } }] } },
          ],
        },
      }),
      prisma.conversation.deleteMany({
        where: { OR: [{ userAId: { in: ids } }, { userBId: { in: ids } }] },
      }),
      prisma.call.deleteMany({
        where: { OR: [{ callerId: { in: ids } }, { calleeId: { in: ids } }] },
      }),
    ]);

    const { count } = await prisma.user.deleteMany({
      where: { id: { in: ids } },
    });
    return count;
  } finally {
    await prisma.$disconnect();
  }
}

const uniquePhone = (() => {
  let n = 0;
  const base = (Date.now() + 5000) % 1_000_000;
  return () => {
    const phone = String(9_000_000_000 + ((base * 17 + ++n * 6151) % 999_999_999));
    createdPhones.push(phone);
    return phone;
  };
})();

async function createAccount({ goal, name }) {
  const phone = uniquePhone();
  const req = await api('POST', '/auth/otp/request', {
    body: { dial_code: '+91', phone },
  });
  const verified = await api('POST', '/auth/otp/verify', {
    body: { dial_code: '+91', phone, code: req.data.dev_code },
  });
  const token = verified.data.access_token;

  // Goal is derived from gender at the location step — there is no separate
  // mode step any more — so the gender sent here has to match the role the
  // caller asked for: female becomes earnMoney, male becomes makeFriends.
  const gender = goal === 'earnMoney' ? 'female' : 'male';
  await api('POST', '/onboarding/gender', { token, body: { gender } });
  await api('POST', '/onboarding/age', { token, body: { age: 26 } });
  await api('POST', '/onboarding/languages', { token, body: { language_codes: ['en'] } });
  await api('POST', '/onboarding/location', { token, body: { city_id: 'chennai' } });
  await api('POST', '/onboarding/profile', { token, body: { name } });
  if (goal === 'earnMoney') {
    const avatars = await api('GET', '/avatars?gender=female', {});
    await api('PUT', '/me/avatar', {
      token,
      body: { avatar_id: avatars.data.avatars[0].id },
    });
  }
  const done = await api('POST', '/onboarding/complete', { token });
  return { token, id: done.data.user.id, name };
}

/** Connects and resolves once the server has acknowledged the session. */
function connect(token) {
  return new Promise((resolve, reject) => {
    const socket = io(SOCKET_URL, { auth: { token }, transports: ['websocket'] });
    const timer = setTimeout(() => reject(new Error('connect timed out')), 8000);
    socket.on('connected', (payload) => {
      clearTimeout(timer);
      socket.hello = payload;
      resolve(socket);
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Resolves with the next `event`, or null if it does not arrive in time. */
function waitFor(socket, event, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      resolve(null);
    }, timeoutMs);
    const handler = (payload) => {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

/** Emits with an acknowledgement, resolving to the server's reply. */
function emit(socket, event, payload, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ success: false, error: 'TIMEOUT' }), timeoutMs);
    socket.emit(event, payload, (reply) => {
      clearTimeout(timer);
      resolve(reply);
    });
  });
}

async function run() {
  console.log(`Vybli sockets end-to-end — ${SOCKET_URL}\n`);

  // ── Authentication ────────────────────────────────────────────────────────
  section('Authentication');

  const rejected = await new Promise((resolve) => {
    const socket = io(SOCKET_URL, { auth: { token: 'nonsense' }, transports: ['websocket'] });
    socket.on('connect_error', (err) => {
      socket.close();
      resolve(err.message);
    });
    socket.on('connected', () => {
      socket.close();
      resolve(null);
    });
    setTimeout(() => resolve('timeout'), 5000);
  });
  check('a forged token cannot open a socket', rejected === 'UNAUTHORIZED', {
    got: rejected,
  });

  // ── Setup ─────────────────────────────────────────────────────────────────
  const earner = await createAccount({ goal: 'earnMoney', name: 'Nila' });
  const caller = await createAccount({ goal: 'makeFriends', name: 'Vikram' });

  let earnerSocket = await connect(earner.token);
  const callerSocket = await connect(caller.token);

  check('a valid token connects', Boolean(earnerSocket.hello));
  check(
    'the handshake carries the unread summary',
    earnerSocket.hello?.unread !== undefined
  );
  check(
    'and reports no active call for a fresh session',
    earnerSocket.hello?.active_call === null
  );

  // ── Presence ──────────────────────────────────────────────────────────────
  section('Presence');

  const online = await api('GET', `/users/${earner.id}`, { token: caller.token });
  check(
    'connecting marks the user online',
    online.data?.user?.status === 'online',
    { got: online.data?.user?.status }
  );

  // ── Chat, opened directly ────────────────────────────────────────────────
  // No request/approval step any more — opening a chat with an eligible
  // earner creates the conversation on the spot, over plain REST, with
  // nothing pushed over the socket for the open itself (only messages,
  // typing and read receipts are real-time events).
  section('Chat');

  const noPushOnOpen = waitFor(earnerSocket, 'notification:new', 1000);
  const opened = await api('POST', `/users/${earner.id}/conversation`, {
    token: caller.token,
  });
  check('opening a chat succeeds immediately, no approval step', opened.success, {
    error: opened.error,
  });
  const conversationId = opened.data?.thread?.id;
  check('it hands back a usable conversation id', Boolean(conversationId));
  check(
    'nothing is pushed over the socket just from opening a chat',
    (await noPushOnOpen) === null
  );

  // ── Messaging ─────────────────────────────────────────────────────────────
  section('Messaging');

  const messageArrived = waitFor(earnerSocket, 'message:new');
  const sendAck = await emit(callerSocket, 'message:send', {
    conversation_id: conversationId,
    text: 'Sent over the socket',
    client_id: 'sock_1',
  });
  check('a message can be sent over the socket', sendAck?.success, { ack: sendAck });
  check('the ack echoes the client id', sendAck?.data?.client_id === 'sock_1');

  const delivered = await messageArrived;
  check('it is delivered to the other side', Boolean(delivered));
  check('with authorship relative to the reader', delivered?.message?.author === 'them', {
    got: delivered?.message?.author,
  });

  // ── Typing ────────────────────────────────────────────────────────────────
  section('Typing');

  const typingArrived = waitFor(earnerSocket, 'typing', 3000);
  callerSocket.emit('typing', { conversation_id: conversationId, is_typing: true });
  const typing = await typingArrived;
  check('a typing indicator reaches the other side', typing?.is_typing === true, {
    got: typing,
  });
  check('and identifies who is typing', typing?.user_id === caller.id);

  // Someone outside the conversation must not be able to fake one.
  const outsider = await createAccount({ goal: 'makeFriends', name: 'Nobody' });
  const outsiderSocket = await connect(outsider.token);
  const fakeTyping = waitFor(earnerSocket, 'typing', 1500);
  outsiderSocket.emit('typing', { conversation_id: conversationId, is_typing: true });
  const faked = await fakeTyping;
  check('a stranger cannot fake a typing indicator', faked === null, { got: faked });

  // ── Read receipts ─────────────────────────────────────────────────────────
  section('Read receipts');

  const readArrived = waitFor(callerSocket, 'message:read', 4000);
  await emit(earnerSocket, 'message:read', { conversation_id: conversationId });
  const readReceipt = await readArrived;
  check('the sender is told their message was read', Boolean(readReceipt), {
    got: readReceipt,
  });

  // ── Delivery receipts ────────────────────────────────────────────────────
  section('Delivery receipts');

  // Live ack: the recipient's socket is open, so acking the moment the
  // message arrives is what flips the sender's tick from one to two.
  const deliverableArrived = waitFor(earnerSocket, 'message:new');
  const deliverableAck = await emit(callerSocket, 'message:send', {
    conversation_id: conversationId,
    text: 'Ack me',
    client_id: 'sock_delivery_1',
  });
  check('a second message can be sent', deliverableAck?.success, { ack: deliverableAck });
  const deliverablePush = await deliverableArrived;
  const deliverableId = deliverablePush?.message?.id;
  check('it arrives with an id to ack', Boolean(deliverableId));

  const deliveredPush = waitFor(callerSocket, 'message:delivered', 4000);
  earnerSocket.emit('message:delivered', { message_id: deliverableId });
  const deliveredReceipt = await deliveredPush;
  check('the sender is told it was delivered', Boolean(deliveredReceipt), {
    got: deliveredReceipt,
  });
  check(
    'naming the message that was delivered',
    Boolean(deliveredReceipt?.message_ids?.includes(deliverableId)),
    { got: deliveredReceipt }
  );

  // Reconnect catch-up: a message sent while the recipient has no socket at
  // all must still flip to delivered the moment they come back — nothing
  // else ever revisits a row still sitting at `sent`.
  earnerSocket.close();
  await new Promise((r) => setTimeout(r, 500));

  const offlineSendAck = await emit(callerSocket, 'message:send', {
    conversation_id: conversationId,
    text: 'While you were away',
    client_id: 'sock_delivery_2',
  });
  check(
    'a message can still be sent while the recipient is offline',
    offlineSendAck?.success,
    { ack: offlineSendAck }
  );
  const offlineMessageId = offlineSendAck?.data?.message?.id;

  const catchUpDelivered = waitFor(callerSocket, 'message:delivered', 6000);
  earnerSocket = await connect(earner.token);
  const catchUpReceipt = await catchUpDelivered;
  check(
    'reconnecting sweeps it into delivered too',
    Boolean(catchUpReceipt?.message_ids?.includes(offlineMessageId)),
    { got: catchUpReceipt, expected: offlineMessageId }
  );

  // ── Calls ─────────────────────────────────────────────────────────────────
  section('Call signalling');

  await api('POST', '/wallet/purchase', {
    token: caller.token,
    body: { package_id: 'pkg_1000' },
  });

  const incoming = waitFor(earnerSocket, 'call:incoming');
  const startAck = await emit(callerSocket, 'call:start', {
    user_id: earner.id,
    type: 'voice',
  });
  check('a call can be started over the socket', startAck?.success, { ack: startAck });

  const ring = await incoming;
  check("the callee's phone rings", Boolean(ring), { got: ring });
  check('the ring names the caller', ring?.peer?.id === caller.id);
  check('and states the price', ring?.rate_per_minute > 0);

  const callId = startAck.data.call.id;

  const acceptedPush = waitFor(callerSocket, 'call:accepted');
  // Minute one is charged as it connects, and the running cost is pushed so
  // the pill on the call screen keeps up without polling.
  const chargedPush = waitFor(callerSocket, 'call:charged');
  const acceptAck = await emit(earnerSocket, 'call:accept', { call_id: callId });
  check('the callee can answer', acceptAck?.success, { ack: acceptAck });
  check('the caller is told it connected', Boolean(await acceptedPush));

  const charged = await chargedPush;
  check('the caller is told what it has cost so far', Boolean(charged), {
    got: charged,
  });
  check('the running cost is the first minute', charged?.amount_spent === ring?.rate_per_minute, {
    got: charged,
    rate: ring?.rate_per_minute,
  });
  check('and it names the call', charged?.call_id === callId);

  // Signalling and track state used to be relayed through this socket. They
  // are LiveKit's now — each client signals with the SFU directly, and a muted
  // track is a property the other side is already subscribed to. The relays
  // were removed rather than left in place: two paths for the same state is
  // how a mute icon comes to disagree with the audio.
  const staleSignal = waitFor(earnerSocket, 'call:signal', 1500);
  callerSocket.emit('call:signal', {
    call_id: callId,
    signal: { type: 'offer', sdp: 'v=0…' },
  });
  check('the manual signalling relay is gone', (await staleSignal) === null);

  const staleMedia = waitFor(earnerSocket, 'call:media', 1500);
  callerSocket.emit('call:media', { call_id: callId, muted: true, camera_on: false });
  check('and so is the manual track-state relay', (await staleMedia) === null);

  // A third party must not be able to reach into someone else's call at all.
  const hijack = waitFor(earnerSocket, 'call:signal', 1500);
  outsiderSocket.emit('call:signal', {
    call_id: callId,
    signal: { type: 'offer', sdp: 'malicious' },
  });
  check('an outsider cannot inject anything', (await hijack) === null);

  // ── In-call chat ──────────────────────────────────────────────────────────
  section('In-call chat');

  const firstMessageArrived = waitFor(earnerSocket, 'call:message');
  const sendMessageAck = await emit(callerSocket, 'call:message', {
    call_id: callId,
    text: 'Hi 👋',
  });
  check('a message can be sent on a live call', sendMessageAck?.success, {
    ack: sendMessageAck,
  });
  const firstMessage = await firstMessageArrived;
  check('it reaches the other side', Boolean(firstMessage), { got: firstMessage });
  check('with the text intact', firstMessage?.text === 'Hi 👋', { got: firstMessage });
  check('and names the sender', firstMessage?.sender_id === caller.id);

  const replyArrived = waitFor(callerSocket, 'call:message');
  const replyAck = await emit(earnerSocket, 'call:message', {
    call_id: callId,
    text: 'Hello 😊',
  });
  check('either side can send, not just the caller', replyAck?.success, {
    ack: replyAck,
  });
  const reply = await replyArrived;
  check('the reply reaches the caller', reply?.text === 'Hello 😊', { got: reply });

  const outsiderMessage = await emit(outsiderSocket, 'call:message', {
    call_id: callId,
    text: 'not yours to read',
  });
  check(
    'a stranger cannot send into someone else\'s call chat',
    !outsiderMessage?.success && outsiderMessage?.error === 'NOT_CALL_PARTICIPANT',
    { got: outsiderMessage }
  );

  const blankMessage = await emit(callerSocket, 'call:message', {
    call_id: callId,
    text: '   ',
  });
  check('a blank message is refused', !blankMessage?.success, { got: blankMessage });

  const endedPush = waitFor(earnerSocket, 'call:ended');
  const endAck = await emit(callerSocket, 'call:end', {
    call_id: callId,
    reason: 'hungUp',
  });
  check('the call can be ended over the socket', endAck?.success, { ack: endAck });
  const endPush = await endedPush;
  check('both sides are told', Boolean(endPush));
  check('the end carries the final cost', endPush?.amount_spent > 0, { got: endPush });

  // The chat was temporary — it does not survive the call it belonged to.
  const afterEndMessage = await emit(callerSocket, 'call:message', {
    call_id: callId,
    text: 'are you still there?',
  });
  check(
    'the chat is gone once the call has ended',
    !afterEndMessage?.success && afterEndMessage?.error === 'CALL_NOT_CONNECTED',
    { got: afterEndMessage }
  );

  // ── Wallet push ───────────────────────────────────────────────────────────
  section('Wallet updates');

  const walletPush = waitFor(callerSocket, 'wallet:updated', 4000);
  await api('POST', '/wallet/purchase', {
    token: caller.token,
    body: { package_id: 'pkg_100' },
  });
  check('a purchase pushes the new balance', Boolean(await walletPush));

  // ── Calling an offline callee ────────────────────────────────────────────
  section('Calling an offline callee');

  const sleeper = await createAccount({ goal: 'earnMoney', name: 'Meera' });
  // Never connected — this is the "no socket at all" case `assertCanCall`
  // used to refuse outright.

  const callingPush = waitFor(callerSocket, 'call:calling');
  const offlineStartAck = await emit(callerSocket, 'call:start', {
    user_id: sleeper.id,
    type: 'voice',
  });
  check('a call to an offline callee still starts', offlineStartAck?.success, {
    ack: offlineStartAck,
  });
  const callingEvent = await callingPush;
  const offlineCallId = offlineStartAck?.data?.call?.id;
  check('the caller sees "calling", not "ringing"', callingEvent?.id === offlineCallId, {
    got: callingEvent,
  });

  const sleeperSocket = io(SOCKET_URL, {
    auth: { token: sleeper.token },
    transports: ['websocket'],
  });
  // Attached before the connect handshake settles, the same way `connect()`
  // does — otherwise a `call:incoming` sent the instant the server sees this
  // socket would fire before anything here was listening for it.
  const sleeperIncoming = waitFor(sleeperSocket, 'call:incoming', 6000);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connect timed out')), 8000);
    sleeperSocket.on('connected', () => {
      clearTimeout(timer);
      resolve();
    });
    sleeperSocket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  const sleeperRing = await sleeperIncoming;
  check('coming online delivers the ring that was waiting', sleeperRing?.id === offlineCallId, {
    got: sleeperRing,
  });

  // Being connected is not the same as the phone having rung — only the
  // device's own acknowledgement moves the caller to "Ringing".
  const prematureRing = waitFor(callerSocket, 'call:ringing', 800);
  check('connecting alone does not claim "ringing"', (await prematureRing) === null);

  const ringUpgrade = waitFor(callerSocket, 'call:ringing', 6000);
  const ringAck = await emit(sleeperSocket, 'call:ring_received', { call_id: offlineCallId });
  check('the callee can acknowledge the ring', ringAck?.success, { ack: ringAck });
  const upgraded = await ringUpgrade;
  check(
    'and upgrades the caller from "calling" to "ringing"',
    upgraded?.id === offlineCallId,
    { got: upgraded }
  );

  const duplicateRing = waitFor(callerSocket, 'call:ringing', 800);
  await emit(sleeperSocket, 'call:ring_received', { call_id: offlineCallId });
  check('a repeated acknowledgement changes nothing', (await duplicateRing) === null);

  // The callee losing signal mid-ring is not a decline: the call keeps going
  // and the caller goes back to "Calling".
  const backToCalling = waitFor(callerSocket, 'call:calling', 6000);
  const notEnded = waitFor(callerSocket, 'call:ended', 1500);
  sleeperSocket.close();
  const downgraded = await backToCalling;
  check(
    'a callee dropping mid-ring sends the caller back to "calling"',
    downgraded?.id === offlineCallId,
    { got: downgraded }
  );
  check('without ending the call', (await notEnded) === null);

  const sleeperBack = io(SOCKET_URL, {
    auth: { token: sleeper.token },
    transports: ['websocket'],
  });
  const reRing = waitFor(sleeperBack, 'call:incoming', 6000);
  const reRinging = waitFor(callerSocket, 'call:ringing', 6000);
  const again = await reRing;
  check('reconnecting in time re-delivers the ring', again?.id === offlineCallId, { got: again });
  await emit(sleeperBack, 'call:ring_received', { call_id: offlineCallId });
  check('and "ringing" returns once acknowledged', (await reRinging)?.id === offlineCallId);

  const declineAck = await emit(sleeperBack, 'call:reject', { call_id: offlineCallId });
  check('the callee can still decline it normally', declineAck?.success, { ack: declineAck });

  sleeperBack.close();

  // A call that ends while the callee has no connection must leave them
  // offline — it used to write `online` for both sides unconditionally.
  const neverOn = await createAccount({ goal: 'earnMoney', name: 'Kavya' });
  const neverOnStart = await emit(callerSocket, 'call:start', {
    user_id: neverOn.id,
    type: 'voice',
  });
  check('a call to a phone that is off starts', neverOnStart?.success, { ack: neverOnStart });
  await emit(callerSocket, 'call:cancel', { call_id: neverOnStart?.data?.call?.id });
  await new Promise((r) => setTimeout(r, 300));
  const neverOnAfter = await api('GET', `/users/${neverOn.id}`, { token: caller.token });
  check(
    'and ending it leaves the callee offline, not "online"',
    neverOnAfter.data?.user?.status === 'offline',
    { got: neverOnAfter.data?.user?.status }
  );

  // ── Presence during calls ────────────────────────────────────────────────
  // `profileService.setPresence` only announces to people with an *open
  // conversation* — right for chat, wrong for two people who have only ever
  // called each other, which is exactly what these two accounts are.
  section('Presence during calls');

  const ringer = await createAccount({ goal: 'makeFriends', name: 'Priya' });
  const ringee = await createAccount({ goal: 'earnMoney', name: 'Divya' });
  await api('POST', '/wallet/purchase', {
    token: ringer.token,
    body: { package_id: 'pkg_1000' },
  });

  const ringerSocket = await connect(ringer.token);
  const ringeeSocket = await connect(ringee.token);

  const ringerToldBusy = waitFor(ringerSocket, 'presence:changed', 4000);
  const ringeeToldBusy = waitFor(ringeeSocket, 'presence:changed', 4000);
  const startAck2 = await emit(ringerSocket, 'call:start', {
    user_id: ringee.id,
    type: 'voice',
  });
  check('a call between strangers still starts', startAck2?.success, { ack: startAck2 });
  const callId2 = startAck2.data.call.id;

  const busyToRinger = await ringerToldBusy;
  check(
    'the caller hears the callee went busy, despite no conversation',
    busyToRinger?.user_id === ringee.id && busyToRinger?.status === 'busy',
    { got: busyToRinger }
  );
  const busyToRingee = await ringeeToldBusy;
  check(
    'and the callee hears the caller went busy too',
    busyToRingee?.user_id === ringer.id && busyToRingee?.status === 'busy',
    { got: busyToRingee }
  );

  const ringerToldOnline = waitFor(ringerSocket, 'presence:changed', 4000);
  const ringeeToldOnline = waitFor(ringeeSocket, 'presence:changed', 4000);
  const cancelAck = await emit(ringerSocket, 'call:cancel', { call_id: callId2 });
  check('the call can be cancelled', cancelAck?.success, { ack: cancelAck });

  const onlineToRinger = await ringerToldOnline;
  check(
    'ending it tells the caller the callee is online again, immediately',
    onlineToRinger?.user_id === ringee.id && onlineToRinger?.status === 'online',
    { got: onlineToRinger }
  );
  const onlineToRingee = await ringeeToldOnline;
  check(
    'and tells the callee the caller is online again',
    onlineToRingee?.user_id === ringer.id && onlineToRingee?.status === 'online',
    { got: onlineToRingee }
  );

  // A disconnect mid-call must report the disconnecting side as *offline*,
  // not the generic "call over" online — otherwise a call-only peer is told
  // something false that nothing ever corrects for them.
  const startAck3 = await emit(ringerSocket, 'call:start', {
    user_id: ringee.id,
    type: 'voice',
  });
  check('another call can start right after', startAck3?.success, { ack: startAck3 });
  const acceptAck3 = await emit(ringeeSocket, 'call:accept', {
    call_id: startAck3.data.call.id,
  });
  check('and be answered', acceptAck3?.success, { ack: acceptAck3 });

  const ringerToldOffline = waitFor(ringerSocket, 'presence:changed', 4000);
  ringeeSocket.close();
  const offlineNotice = await ringerToldOffline;
  check(
    'the caller learns the callee actually went offline, not "online"',
    offlineNotice?.user_id === ringee.id && offlineNotice?.status === 'offline',
    { got: offlineNotice }
  );

  ringerSocket.close();

  // ── Call again, straight away ───────────────────────────────────────────
  // Call → answer → end → call again, with no pause in between — the flow that
  // used to say "on another call" about someone who was not.
  section('Calling again straight away');

  const again1 = await createAccount({ goal: 'makeFriends', name: 'Ravi' });
  const again2 = await createAccount({ goal: 'earnMoney', name: 'Anu' });
  await api('POST', '/wallet/purchase', {
    token: again1.token,
    body: { package_id: 'pkg_1000' },
  });
  const a1 = await connect(again1.token);
  const a2 = await connect(again2.token);

  // Every `call:ended` either side ever hears, by call id — so a duplicate
  // for an old call is caught however late it lands.
  const endedSeen = new Map();
  for (const sock of [a1, a2]) {
    sock.on('call:ended', (p) => endedSeen.set(p.call_id, (endedSeen.get(p.call_id) ?? 0) + 1));
  }

  const ids = new Set();
  let previousId = null;
  for (let round = 1; round <= 3; round++) {
    const incoming = waitFor(a2, 'call:incoming');
    // Fired immediately after the previous round's `call:end`, not after its
    // ack — the order a phone actually sends them in.
    const startAck = await emit(a1, 'call:start', { user_id: again2.id, type: 'voice' });
    check(`round ${round}: the call places`, startAck?.success, { ack: startAck });
    const id = startAck?.data?.call?.id;
    check(`round ${round}: with a new call id`, Boolean(id) && !ids.has(id), { id });
    ids.add(id);

    const ring = await incoming;
    check(`round ${round}: the callee is rung for *this* call`, ring?.id === id, {
      got: ring?.id,
      want: id,
    });

    const accepted = waitFor(a1, 'call:accepted');
    const acceptAck = await emit(a2, 'call:accept', { call_id: id });
    check(`round ${round}: it can be answered`, acceptAck?.success, { ack: acceptAck });
    const acceptedEvent = await accepted;
    check(
      `round ${round}: the caller hears the answer for this call, not an old one`,
      acceptedEvent?.call_id === id,
      { got: acceptedEvent }
    );

    // Hang up and do not wait: the next round's start goes out right behind.
    a1.emit('call:end', { call_id: id, reason: 'hungUp' });
    previousId = id;
  }
  await emit(a1, 'call:end', { call_id: previousId, reason: 'hungUp' });

  // Hanging up on a call that is already over changes nothing and tells
  // nobody anything a second time.
  await emit(a2, 'call:end', { call_id: previousId, reason: 'hungUp' });
  await new Promise((r) => setTimeout(r, 400));
  check(
    'every call was ended exactly once per side — no duplicate `call:ended`',
    [...ids].every((id) => endedSeen.get(id) === 2),
    { seen: Object.fromEntries(endedSeen) }
  );

  // A retried start (the app's REST fallback after a lost ack) returns the
  // call the first attempt placed instead of refusing as busy.
  const first = await emit(a1, 'call:start', {
    user_id: again2.id,
    type: 'voice',
    client_id: 'retry-me',
  });
  const retried = await api('POST', '/calls', {
    token: again1.token,
    body: { user_id: again2.id, type: 'voice', client_id: 'retry-me' },
  });
  check('a retried start is not refused as busy', retried.success, { got: retried });
  check(
    'and hands back the same call',
    retried.data?.call?.id === first?.data?.call?.id,
    { first: first?.data?.call?.id, retried: retried.data?.call?.id }
  );

  // A cancel crossing an answer: whichever lands second must not leave the
  // call connected and billing behind a caller who hung up.
  const crossedId = first?.data?.call?.id;
  await Promise.all([
    emit(a2, 'call:accept', { call_id: crossedId }),
    emit(a1, 'call:cancel', { call_id: crossedId }),
  ]);
  const crossed = await api('GET', '/calls/active', { token: again1.token });
  check('a cancel crossing an answer leaves no live call behind', !crossed.data?.call, {
    got: crossed.data?.call?.status,
  });

  a1.close();
  a2.close();

  // ── Watching presence ───────────────────────────────────────────────────
  // A discovery card or profile on screen — no conversation needed.
  section('Watching presence');

  const watcher = await createAccount({ goal: 'makeFriends', name: 'Nila' });
  const watched = await createAccount({ goal: 'earnMoney', name: 'Isha' });
  const watcherSocket = await connect(watcher.token);

  const watchAck = await emit(watcherSocket, 'presence:watch', { user_ids: [watched.id] });
  check('a screen can watch presence', watchAck?.success, { ack: watchAck });
  check(
    'and is answered with the current status',
    watchAck?.data?.[0]?.user_id === watched.id && watchAck?.data?.[0]?.status === 'offline',
    { got: watchAck?.data }
  );

  const cameOnline = waitFor(watcherSocket, 'presence:changed', 4000);
  const watchedSocket = await connect(watched.token);
  const onlineEvent = await cameOnline;
  check(
    'it hears the watched person come online, live',
    onlineEvent?.user_id === watched.id && onlineEvent?.status === 'online',
    { got: onlineEvent }
  );

  const wentOffline = waitFor(watcherSocket, 'presence:changed', 4000);
  watchedSocket.close();
  const offlineEvent = await wentOffline;
  check(
    'and go offline, live',
    offlineEvent?.user_id === watched.id && offlineEvent?.status === 'offline',
    { got: offlineEvent }
  );

  await emit(watcherSocket, 'presence:watch', { user_ids: [] });
  const afterUnwatch = waitFor(watcherSocket, 'presence:changed', 1500);
  const watchedAgain = await connect(watched.token);
  check('an empty watch list stops the updates', (await afterUnwatch) === null);
  watchedAgain.close();
  watcherSocket.close();

  // ── Presence on disconnect ────────────────────────────────────────────────
  section('Disconnect');

  callerSocket.close();
  await new Promise((r) => setTimeout(r, 1200));
  const afterClose = await api('GET', `/users/${caller.id}`, { token: earner.token });
  check(
    'disconnecting marks the user offline',
    afterClose.data?.user?.status === 'offline' || afterClose.success === false,
    { got: afterClose.data?.user?.status }
  );

  earnerSocket.close();
  outsiderSocket.close();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  • ${f.label}${f.detail ? ` — ${JSON.stringify(f.detail)}` : ''}`);
    }
  }
  const removed = await removeCreatedAccounts();
  console.log(`  cleaned up ${removed} test account${removed === 1 ? '' : 's'}`);
  console.log(`${'═'.repeat(60)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(async (err) => {
  console.error('\nThe run itself failed:', err);
  // A failed run leaves accounts behind too, and those are the runs most
  // likely to be repeated.
  try {
    console.error(`(cleaned up ${await removeCreatedAccounts()} test accounts anyway)`);
  } catch (cleanupError) {
    console.error('(cleanup also failed:', cleanupError.message, ')');
  }
  process.exit(1);
});
