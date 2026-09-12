'use strict';

/**
 * The admin API, against a running server.
 *
 *   node src/server.js        # terminal one
 *   npm run test:admin        # terminal two
 *
 * Asserts the rules rather than the status codes: that an unauthenticated
 * request cannot reach anybody's messages, that a user token is not an admin
 * token, that reading a private conversation writes an audit row, and that a
 * suspension without a reason is refused.
 */

const BASE = process.env.API_BASE || 'http://localhost:4000/api/v1';
const USERNAME = process.env.ADMIN_USERNAME || 'admin';
const PASSWORD = process.env.ADMIN_TEST_PASSWORD || 'Vybli!Admin2026';

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
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
}

async function api(method, path, { token, body, raw } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => null);
  return raw ? { status: res.status, json } : json;
}

const get = (path, token) => api('GET', path, { token });
const post = (path, token, body) => api('POST', path, { token, body });

(async () => {
  console.log(`\nVybli admin API — ${BASE}\n`);

  // ── Authentication ────────────────────────────────────────────────────────
  section('Authentication');

  const noCreds = await api('POST', '/admin/auth/login', {
    body: { username: USERNAME, password: 'definitely-not-the-password' },
    raw: true,
  });
  check(
    'a wrong password is refused',
    noCreds.status === 401 && noCreds.json?.error === 'ADMIN_BAD_CREDENTIALS',
    { status: noCreds.status, error: noCreds.json?.error }
  );
  check(
    'and it says how many attempts are left',
    /attempt/i.test(noCreds.json?.message ?? ''),
    { message: noCreds.json?.message }
  );

  const wrongUser = await api('POST', '/admin/auth/login', {
    body: { username: 'someone-else', password: PASSWORD },
    raw: true,
  });
  check(
    'a wrong username is refused the same way',
    wrongUser.status === 401,
    { status: wrongUser.status }
  );
  check(
    'and does not reveal which half was wrong',
    wrongUser.json?.message?.replace(/\d+/g, '#') === noCreds.json?.message?.replace(/\d+/g, '#'),
    { a: wrongUser.json?.message, b: noCreds.json?.message }
  );

  const login = await api('POST', '/admin/auth/login', {
    body: { username: USERNAME, password: PASSWORD },
  });
  check('the configured credential signs in', login.success, { error: login.error });
  if (!login.success) {
    console.log('\nCannot continue without a session. Set ADMIN_TEST_PASSWORD.\n');
    process.exit(1);
  }

  const token = login.data.token;
  check('a session token is issued', typeof token === 'string' && token.length > 40);
  check('with an expiry', Boolean(login.data.expires_at));
  check('the password is never echoed back', !JSON.stringify(login.data).includes(PASSWORD));

  // ── Protection ────────────────────────────────────────────────────────────
  section('Protection');

  const anonymous = await api('GET', '/admin/dashboard', { raw: true });
  check(
    'the dashboard is unreachable without a token',
    anonymous.status === 401,
    { status: anonymous.status }
  );

  const anonUsers = await api('GET', '/admin/users', { raw: true });
  check('so is the user list', anonUsers.status === 401);

  const anonConv = await api('GET', '/admin/conversations', { raw: true });
  check('and so are conversations — nobody reads messages unauthenticated', anonConv.status === 401);

  const garbage = await api('GET', '/admin/dashboard', { token: 'not-a-token', raw: true });
  check('a forged token is refused', garbage.status === 401);

  // A real *user* token must not open the admin panel. The two are signed with
  // different secrets precisely so this cannot happen.
  const otp = await api('POST', '/auth/otp/request', {
    body: { dial_code: '+91', phone: '9999999999' },
  });
  if (otp.data?.dev_code) {
    const verify = await api('POST', '/auth/otp/verify', {
      body: { dial_code: '+91', phone: '9999999999', code: otp.data.dev_code },
    });
    const userToken = verify.data?.access_token;
    if (userToken) {
      const asUser = await api('GET', '/admin/dashboard', { token: userToken, raw: true });
      check(
        'a signed-in user cannot use the admin API',
        asUser.status === 401,
        { status: asUser.status }
      );
    }
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────
  section('Dashboard');

  const dash = await get('/admin/dashboard', token);
  check('the dashboard loads', dash.success, { error: dash.error });
  const d = dash.data;
  check('user counts are present', typeof d?.users?.total === 'number');
  check(
    'online, busy and offline add up to the total',
    d.users.online + d.users.busy + d.users.offline === d.users.total,
    { online: d.users.online, busy: d.users.busy, offline: d.users.offline, total: d.users.total }
  );
  check(
    'verified and unverified add up to the total',
    d.users.verified + d.users.unverified === d.users.total
  );
  check('finance figures are numbers, not strings', typeof d.finance.total_earnings === 'number');
  check('moderation counts are present', typeof d.moderation.reports_open === 'number');

  const analytics = await get('/admin/dashboard/analytics?metrics=registrations,messages&days=6', token);
  check('analytics returns a series', Array.isArray(analytics.data?.series?.registrations));
  check(
    'with one point per day, including empty ones',
    analytics.data.series.registrations.length === 7,
    { length: analytics.data.series.registrations.length }
  );
  check(
    'each point has a date and a numeric value',
    analytics.data.series.registrations.every(
      (p) => typeof p.date === 'string' && typeof p.value === 'number'
    )
  );

  // ── Users ─────────────────────────────────────────────────────────────────
  section('Users');

  const users = await get('/admin/users?limit=5', token);
  check('the user list loads', users.success);
  check('it is paginated', typeof users.data?.pagination?.total === 'number');
  check('and capped at the requested size', users.data.items.length <= 5);

  const sample = users.data.items[0];
  check('a row carries the profile', Boolean(sample?.id && sample?.phone !== undefined));
  check('and activity counts, without an extra request', Boolean(sample?.counts));

  const filtered = await get('/admin/users?filter=online&limit=100', token);
  check(
    'the online filter returns only online accounts',
    filtered.data.items.every((u) => u.presence === 'online'),
    { presences: [...new Set(filtered.data.items.map((u) => u.presence))] }
  );

  const searched = await get(`/admin/users?search=${encodeURIComponent(sample.id)}`, token);
  check(
    'searching by user id finds exactly that account',
    searched.data.items.length === 1 && searched.data.items[0].id === sample.id,
    { found: searched.data.items.length }
  );

  const missing = await api('GET', '/admin/users/does-not-exist', { token, raw: true });
  check('an unknown user is a 404, not a 500', missing.status === 404, { status: missing.status });

  // ── Per-user tabs ─────────────────────────────────────────────────────────
  section('Individual user');

  const TABS = [
    'activity', 'friends', 'requests', 'messages', 'calls', 'verification',
    'wallet', 'transactions', 'earnings', 'reports', 'blocks', 'notifications', 'history',
  ];
  let tabsOk = true;
  for (const tab of TABS) {
    const res = await api('GET', `/admin/users/${sample.id}/${tab}?limit=3`, { token, raw: true });
    if (res.status !== 200) {
      tabsOk = false;
      check(`tab ${tab} responds`, false, { status: res.status, error: res.json?.error });
    }
  }
  check(`all ${TABS.length} per-user tabs respond`, tabsOk);

  const overview = await get(`/admin/users/${sample.id}`, token);
  check('the overview carries the full statistics block', typeof overview.data?.stats?.friends === 'number');
  check('and the last activity, or null', 'last_activity' in overview.data);

  // ── Conversations ─────────────────────────────────────────────────────────
  section('Conversations and the audit trail');

  const conversations = await get('/admin/conversations?limit=1', token);
  check('conversations list', conversations.success);

  const conversation = conversations.data.items[0];
  if (conversation) {
    const before = await get('/admin/audit-logs?action=conversation.viewed&limit=1', token);
    const beforeCount = before.data.pagination.total;

    const thread = await get(`/admin/conversations/${conversation.id}?limit=10`, token);
    check('a conversation opens', thread.success, { error: thread.error });
    check('with its participants', thread.data?.conversation?.participants?.length === 2);
    check('and its messages', Array.isArray(thread.data?.messages));

    if (thread.data.messages.length > 0) {
      const m = thread.data.messages[0];
      check('a message carries the sender', Boolean(m.sender?.id));
      check('the recipient', Boolean(m.recipient_id));
      check('a timestamp and a status', Boolean(m.created_at && m.status));
    }

    // The reason the audit log exists.
    await new Promise((r) => setTimeout(r, 300));
    const after = await get('/admin/audit-logs?action=conversation.viewed&limit=1', token);
    check(
      'reading a private conversation is written to the audit log',
      after.data.pagination.total === beforeCount + 1,
      { before: beforeCount, after: after.data.pagination.total }
    );
    check(
      'and the entry names the conversation',
      after.data.items[0]?.target_id === conversation.id,
      { target: after.data.items[0]?.target_id }
    );
    check('and records the address it came from', Boolean(after.data.items[0]?.ip));
  } else {
    console.log('  · no conversations on this database — skipping the chat checks');
  }

  const shortSearch = await api('GET', '/admin/messages?search=a', { token, raw: true });
  check(
    'a one-character message search is refused rather than scanning everything',
    shortSearch.status === 400,
    { status: shortSearch.status }
  );

  // ── Moderation guards ─────────────────────────────────────────────────────
  section('Moderation guards');

  const noReason = await api('POST', `/admin/users/${sample.id}/status`, {
    token,
    body: { status: 'suspended' },
    raw: true,
  });
  check(
    'suspending without a reason is refused',
    noReason.status === 400,
    { status: noReason.status, message: noReason.json?.message }
  );

  const badStatus = await api('POST', `/admin/users/${sample.id}/status`, {
    token,
    body: { status: 'banished', reason: 'x' },
    raw: true,
  });
  check('an unknown status is refused', badStatus.status === 400);

  const noAmount = await api('POST', `/admin/users/${sample.id}/wallet/adjust`, {
    token,
    body: { reason: 'testing' },
    raw: true,
  });
  check('a wallet adjustment with no amount is refused', noAmount.status === 400);

  const noWhy = await api('POST', `/admin/users/${sample.id}/wallet/adjust`, {
    token,
    body: { balance: 10 },
    raw: true,
  });
  check('and one with no reason is refused', noWhy.status === 400);

  const verifications = await get('/admin/verifications?limit=1', token);
  check('the verification queue loads', verifications.success);
  if (verifications.data.items[0]) {
    const v = verifications.data.items[0];
    check('a queue entry never carries a recording URL', !('sample_url' in v) && !('url' in v), {
      keys: Object.keys(v),
    });

    const noReasonReject = await api('POST', `/admin/verifications/${v.user_id}/decide`, {
      token,
      body: { decision: 'rejected' },
      raw: true,
    });
    check(
      'rejecting a verification without a reason is refused',
      noReasonReject.status === 400,
      { status: noReasonReject.status }
    );
  }

  const reports = await get('/admin/reports?limit=1', token);
  check('the report queue loads', reports.success);
  if (reports.data.items[0]) {
    const closeWithoutResolution = await api('POST', `/admin/reports/${reports.data.items[0].id}/resolve`, {
      token,
      body: { status: 'resolved' },
      raw: true,
    });
    check(
      'closing a report without saying what was decided is refused',
      closeWithoutResolution.status === 400
    );
  }

  // ── Everything else responds ──────────────────────────────────────────────
  section('Remaining endpoints');

  const ENDPOINTS = [
    'activity?limit=3', 'calls?limit=3', 'calls/live', 'livekit/rooms',
    'friend-requests?limit=3', 'blocks?limit=3', 'wallets?limit=3',
    'transactions?limit=3', 'earnings?limit=3', 'languages', 'locations',
    'notifications?limit=3', 'messages/stats', 'audit-logs?limit=3',
  ];
  let allOk = true;
  for (const ep of ENDPOINTS) {
    const res = await api('GET', `/admin/${ep}`, { token, raw: true });
    if (res.status !== 200) {
      allOk = false;
      check(`GET /admin/${ep}`, false, { status: res.status, error: res.json?.error });
    }
  }
  check(`all ${ENDPOINTS.length} remaining endpoints respond`, allOk);

  const languages = await get('/admin/languages', token);
  check('languages carry a user count', typeof languages.data.items[0]?.user_count === 'number');

  const locations = await get('/admin/locations', token);
  check('locations carry a user count', typeof locations.data.items[0]?.user_count === 'number');

  const audit = await get('/admin/audit-logs?limit=5', token);
  check('the audit log lists the actions available to filter on', Array.isArray(audit.data.actions));

  // ── Session ───────────────────────────────────────────────────────────────
  section('Session');

  const me = await get('/admin/auth/session', token);
  check('the session can be inspected', me.data?.username === USERNAME);
  check('and reports its expiry', Boolean(me.data?.expires_at));

  const out = await post('/admin/auth/logout', token);
  check('signing out is accepted and audited', out.success);

  console.log(`\n${'═'.repeat(62)}`);
  const removed = await removeProbeUser();
  if (removed) console.log(`  cleaned up ${removed} test account`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`${'═'.repeat(62)}\n`);

  if (failed > 0) {
    console.log('Failures:');
    for (const f of failures) console.log(`  • ${f.label}${f.detail ? ` — ${JSON.stringify(f.detail)}` : ''}`);
    console.log('');
    process.exit(1);
  }

/**
 * Removes the throwaway user this suite signs in as.
 *
 * It exists only to prove a *user* token cannot open the admin API. Left
 * behind it becomes another permanent resident of the development database —
 * and on a machine that is also somebody's phone, another stranger in the feed.
 */
async function removeProbeUser() {
  const { createPrismaClient } = require('../src/config/prismaClient');
  const prisma = createPrismaClient();
  try {
    const { count } = await prisma.user.deleteMany({
      where: { phone: { contains: '9999999999' } },
    });
    return count;
  } finally {
    await prisma.$disconnect();
  }
}

})().catch((err) => {
  console.error('\nThe admin suite could not run:', err.message);
  console.error('Is the server up? node src/server.js\n');
  process.exit(1);
});
