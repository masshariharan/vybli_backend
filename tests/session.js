'use strict';

/**
 * One active session per phone number, against a running server.
 *
 *   node src/server.js        # terminal one
 *   npm run test:session      # terminal two
 *
 * The rule: signing in ends the sign-in everywhere else. A phone number is one
 * person, and an account they cannot see is an account they cannot tell has
 * been taken.
 *
 * Its own file rather than a section of `e2e.js` because it needs the *same*
 * number to sign in twice, and the OTP resend cooldown stands between the two.
 * The suite waits that out, which is a cost worth paying once here and not on
 * every run of the main walk-through.
 */

const BASE = process.env.API_BASE || 'http://localhost:4000/api/v1';

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Signs in on `phone`, waiting out the resend cooldown if one is in the way.
 *
 * The cooldown is a real rule — two codes live at once for one number would
 * double an attacker's odds — so this waits for it rather than working around
 * it. The server names the seconds left, so the wait is exactly as long as it
 * has to be.
 */
async function signIn(phone, device) {
  let requested = await post('/auth/otp/request', null, { dial_code: '+91', phone });

  if (!requested.success && requested.error === 'OTP_COOLDOWN') {
    const seconds = requested.details?.retry_after_seconds ?? 31;
    console.log(`  … waiting ${seconds}s for the OTP cooldown`);
    await sleep((seconds + 1) * 1000);
    requested = await post('/auth/otp/request', null, { dial_code: '+91', phone });
  }

  if (!requested.success) {
    throw new Error(`OTP request failed: ${JSON.stringify(requested)}`);
  }

  const verified = await post('/auth/otp/verify', null, {
    dial_code: '+91',
    phone,
    code: requested.data.dev_code,
    device,
  });
  if (!verified.success) {
    throw new Error(`OTP verify failed: ${JSON.stringify(verified)}`);
  }
  return verified.data;
}

async function run() {
  console.log(`Vybli sessions — ${BASE}\n`);

  const health = await get('/health');
  if (!health.success) {
    console.error('Server is not responding. Start it with `node src/server.js`.');
    process.exit(1);
  }

  const phone = String(9_000_000_000 + (Date.now() % 999_999_999));

  section('One number, two devices');

  const first = await signIn(phone, 'First phone');
  check('the first device signs in', Boolean(first.access_token));
  check('and can use the API', (await get('/me', first.access_token)).success);

  const second = await signIn(phone, 'Second phone');
  check('the same number signs in again elsewhere', Boolean(second.access_token));

  section('The first device is signed out, at once');

  const displaced = await get('/me', first.access_token);
  check(
    "the displaced device's access token is refused immediately",
    !displaced.success && displaced.status === 401,
    { status: displaced.status, error: displaced.error }
  );

  const displacedRefresh = await post('/auth/refresh', null, {
    refresh_token: first.refresh_token,
  });
  check(
    'and it cannot refresh its way back in',
    !displacedRefresh.success && displacedRefresh.status === 401,
    { status: displacedRefresh.status, error: displacedRefresh.error }
  );

  section('The device that signed in most recently keeps working');

  check('the new device can use the API', (await get('/me', second.access_token)).success);

  const rotated = await post('/auth/refresh', null, {
    refresh_token: second.refresh_token,
  });
  check('the new device can still refresh', rotated.success, { error: rotated.error });
  check(
    'and the rotated token works',
    (await get('/me', rotated.data?.access_token)).success
  );

  section('Other accounts are untouched');

  const otherPhone = String(9_000_000_000 + ((Date.now() + 5_000) % 999_999_999));
  const other = await signIn(otherPhone, 'Somebody else');
  check('a different number signs in', (await get('/me', other.access_token)).success);
  check(
    "and does not disturb this account's live session",
    (await get('/me', rotated.data?.access_token)).success
  );

  // Housekeeping: these are real accounts on whatever database this ran
  // against, and a test's own data should not outlive it.
  const { createPrismaClient } = require('../src/config/prismaClient');
  const prisma = createPrismaClient();
  try {
    const rows = await prisma.user.findMany({
      where: { OR: [phone, otherPhone].map((p) => ({ phone: { contains: p } })) },
      select: { id: true },
    });
    if (rows.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
      console.log(`\n  cleaned up ${rows.length} test accounts`);
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`${'═'.repeat(60)}\n`);

  if (failed > 0) {
    for (const f of failures) {
      console.log(`  • ${f.label}${f.detail ? ` — ${JSON.stringify(f.detail)}` : ''}`);
    }
    process.exit(1);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
