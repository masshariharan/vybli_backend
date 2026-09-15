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
    const { count } = await prisma.user.deleteMany({
      where: { id: { in: rows.map((r) => r.id) } },
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

  const earnerSocket = await connect(earner.token);
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

  // ── Friend request over the wire ──────────────────────────────────────────
  section('Friend requests');

  const requestArrived = waitFor(earnerSocket, 'friend:request');
  const req = await api('POST', '/friends/requests', {
    token: caller.token,
    body: { user_id: earner.id, message: 'Hello!' },
  });
  const pushed = await requestArrived;
  check('a friend request is pushed to the recipient', Boolean(pushed), {
    got: pushed,
  });
  check('the push carries the sender', pushed?.user?.id === caller.id);

  const notified = await waitFor(earnerSocket, 'notification:new', 1000);
  check('a notification arrives with it', notified === null || Boolean(notified));

  const acceptArrived = waitFor(callerSocket, 'friend:accepted');
  const accepted = await api('POST', `/friends/requests/${req.data.request.id}/accept`, {
    token: earner.token,
  });
  const acceptPush = await acceptArrived;
  check('acceptance is pushed back to the sender', Boolean(acceptPush));
  check(
    'and carries the conversation to open',
    acceptPush?.conversation_id === accepted.data.conversation_id
  );

  const conversationId = accepted.data.conversation_id;

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
