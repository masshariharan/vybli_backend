'use strict';

/**
 * The security fixes that are not about encryption, against a running server.
 *
 *   node src/server.js        # terminal one
 *   npm run test:hardening    # terminal two
 *
 * Slow on purpose — about a minute. Two of the rules below are about time
 * (a reused refresh token is only treated as stolen once the grace for a
 * legitimate race has passed, and live sockets are re-checked every thirty
 * seconds), and the only honest test of either is to wait.
 */

const {
  check,
  section,
  get,
  post,
  createAccount,
  online,
  cleanup,
  summary,
  fail,
  BASE,
} = require('./lib/client');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function emit(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

async function run() {
  console.log(`Vybli hardening — ${BASE}\n`);

  const payer = await createAccount({ name: 'Harden Payer', gender: 'male' });
  const earner = await createAccount({ name: 'Harden Earner', gender: 'female' });

  // ── Roles are fixed after sign-up ────────────────────────────────────────
  section('Onboarding after sign-up');

  const flip = await post('/onboarding/gender', payer.token, { gender: 'female' });
  check(
    'a finished account cannot change its gender',
    flip.status === 409 && flip.error === 'GENDER_LOCKED',
    flip
  );
  await post('/onboarding/location', payer.token, { city_id: 'mumbai' });
  const me = await get('/me', payer.token);
  check(
    'and re-sending the location step does not make it an earner',
    me.data?.user?.is_earner === false || me.data?.user?.goal === 'makeFriends',
    me.data?.user
  );

  // ── Blocking reaches presence ────────────────────────────────────────────
  section('Presence after a block');

  const payerSocket = await online(payer);
  const before = await emit(payerSocket, 'presence:watch', { user_ids: [earner.id] });
  check(
    'before a block, presence can be watched',
    before?.success && before.data.some((p) => p.user_id === earner.id),
    before
  );
  await post('/moderation/block', earner.token, { user_id: payer.id });
  const after = await emit(payerSocket, 'presence:watch', { user_ids: [earner.id] });
  check(
    'once blocked, the blocked person cannot watch their presence',
    after?.success && !after.data.some((p) => p.user_id === earner.id),
    after
  );
  await post('/moderation/block', payer.token, { user_id: earner.id }).catch(() => {});

  // ── The socket's own limits ──────────────────────────────────────────────
  section('Socket sends');

  const other = await createAccount({ name: 'Harden Other', gender: 'female' });
  const thread = await post(`/users/${other.id}/conversation`, payer.token);
  const conversationId = thread.data?.thread?.id;
  const results = [];
  for (let i = 0; i < 65; i += 1) {
    results.push(
      emit(payerSocket, 'message:send', { conversation_id: conversationId, text: `m${i}` })
    );
  }
  const acks = await Promise.all(results);
  check(
    'sending faster than the HTTP route allows is refused over the socket too',
    acks.some((a) => a?.error === 'RATE_LIMITED'),
    acks.filter((a) => !a?.success).slice(0, 2)
  );

  const leak = await emit(payerSocket, 'message:send', { conversation_id: 'nope' });
  check(
    'a failed socket send does not echo internal error text',
    leak?.success === false && !/prisma|sql|relation|column/i.test(leak?.message ?? ''),
    leak
  );

  // ── Stolen refresh tokens ────────────────────────────────────────────────
  section('Refresh token reuse');

  const first = await post('/auth/refresh', null, { refresh_token: payer.refreshToken });
  check('a refresh token rotates', first.success, first);
  const racing = await post('/auth/refresh', null, { refresh_token: payer.refreshToken });
  check('the old one is refused', racing.status === 401, racing);
  const stillFine = await get('/me', first.data?.access_token);
  check(
    'but a replay within seconds (a legitimate race) signs nobody out',
    stillFine.success,
    stillFine
  );

  const socketClosed = new Promise((resolve) => payerSocket.once('disconnect', () => resolve(true)));
  console.log('  … waiting out the 30 s grace for a racing refresh');
  await sleep(31_000);
  const replay = await post('/auth/refresh', null, { refresh_token: payer.refreshToken });
  check('a replay after that is refused', replay.status === 401, replay);
  const newest = await post('/auth/refresh', null, {
    refresh_token: first.data?.refresh_token,
  });
  check(
    'and ends every session, so whoever else holds the token is out too',
    newest.status === 401,
    newest
  );

  // ── Sockets follow the sign-in ───────────────────────────────────────────
  section('Open sockets');

  console.log('  … waiting for the socket sweep (every 30 s)');
  const closed = await Promise.race([socketClosed, sleep(35_000).then(() => false)]);
  check('a socket whose account has no live session left is closed', closed);

  payerSocket.close();
}

run()
  .catch((err) => fail(`\nCrashed: ${err.stack ?? err}`))
  .finally(async () => {
    try {
      await cleanup();
    } catch (err) {
      console.error('cleanup failed', err);
    }
    const { passed, failed } = summary();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
