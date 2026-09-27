'use strict';

/**
 * What the newer integration suites share: a signed-in test account, its
 * socket, a pass/fail tally, and cleanup that leaves nothing behind. The
 * older suites (`e2e.js` and friends) predate this and keep their own copies.
 */

const { io } = require('socket.io-client');

const BASE = process.env.API_BASE || 'http://localhost:4000/api/v1';
const SOCKET_URL = process.env.SOCKET_URL || BASE.replace(/\/api\/v1\/?$/, '');

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
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
  let json;
  try {
    json = await res.json();
  } catch {
    json = { success: false, message: 'Non-JSON response' };
  }
  return { status: res.status, ...json };
}

const get = (p, t) => api('GET', p, { token: t });
const post = (p, t, b) => api('POST', p, { token: t, body: b });
const put = (p, t, b) => api('PUT', p, { token: t, body: b });
const patch = (p, t, b) => api('PATCH', p, { token: t, body: b });
const del = (p, t, b) => api('DELETE', p, { token: t, body: b });

const createdPhones = [];
const uniquePhone = (() => {
  let n = 0;
  const base = Date.now() % 1_000_000;
  return () => {
    const phone = String(8_000_000_000 + ((base * 17 + ++n * 7919) % 999_999_999));
    createdPhones.push(phone);
    return phone;
  };
})();

async function createAccount({ name, gender }) {
  const phone = uniquePhone();
  const requested = await post('/auth/otp/request', null, { dial_code: '+91', phone });
  if (!requested.success) throw new Error(`OTP request failed: ${requested.message}`);
  const verified = await post('/auth/otp/verify', null, {
    dial_code: '+91',
    phone,
    code: requested.data.dev_code,
  });
  if (!verified.success) throw new Error(`OTP verify failed: ${verified.message}`);
  const token = verified.data.access_token;
  await post('/onboarding/gender', token, { gender });
  await post('/onboarding/age', token, { age: 26 });
  await post('/onboarding/languages', token, { language_codes: ['en'] });
  await post('/onboarding/location', token, { city_id: 'chennai' });
  await post('/onboarding/profile', token, { name, bio: `Hi, I am ${name}.` });
  if (gender === 'female') {
    const avatars = await get('/avatars?gender=female', null);
    await put('/me/avatar', token, { avatar_id: avatars.data.avatars[0].id });
  }
  const completed = await post('/onboarding/complete', token);
  if (!completed.success) throw new Error(`Onboarding failed: ${JSON.stringify(completed)}`);
  return {
    token,
    refreshToken: verified.data.refresh_token,
    id: completed.data.user.id,
    name,
  };
}

async function online(account) {
  const socket = io(SOCKET_URL, { auth: { token: account.token }, transports: ['websocket'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket connect timed out')), 8000);
    socket.on('connected', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  return socket;
}

function nextEvent(socket, name, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    socket.once(name, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}


async function withPrisma(fn) {
  const { createPrismaClient } = require('../../src/config/prismaClient');
  const prisma = createPrismaClient();
  try {
    return await fn(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

async function cleanup() {
  if (createdPhones.length === 0) return;
  await withPrisma(async (prisma) => {
    const rows = await prisma.user.findMany({
      where: { OR: createdPhones.map((phone) => ({ phone: { contains: phone } })) },
      select: { id: true },
    });
    const ids = rows.map((r) => r.id);
    if (!ids.length) return;
    const inConversation = { OR: [{ userAId: { in: ids } }, { userBId: { in: ids } }] };
    await prisma.$transaction([
      prisma.message.deleteMany({
        where: { OR: [{ senderId: { in: ids } }, { conversation: inConversation }] },
      }),
      prisma.conversation.deleteMany({ where: inConversation }),
      prisma.report.deleteMany({
        where: { OR: [{ reporterId: { in: ids } }, { reportedId: { in: ids } }] },
      }),
      prisma.user.deleteMany({ where: { id: { in: ids } } }),
    ]);
  });
}

function summary() {
  return { passed, failed };
}

function fail(label) {
  failed += 1;
  console.error(label);
}

module.exports = {
  BASE,
  check,
  section,
  get,
  post,
  put,
  patch,
  del,
  createAccount,
  online,
  nextEvent,
  withPrisma,
  cleanup,
  summary,
  fail,
};
