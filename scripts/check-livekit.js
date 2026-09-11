'use strict';

const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');
const env = require('../src/config/env');

/**
 * Proves the LiveKit credentials actually work, before a call depends on them.
 *
 * Worth its own script because the failure is otherwise invisible until two
 * people are on a call that rings, bills, and carries no audio. The server
 * mints join tokens locally — signing one never contacts LiveKit — so a wrong
 * secret produces a perfectly well-formed token that the SFU then rejects, at
 * the worst possible moment.
 *
 *   node scripts/check-livekit.js
 */

const ok = (m) => console.log(`  \x1b[32mok\x1b[0m    ${m}`);
const bad = (m) => console.log(`  \x1b[31mFAIL\x1b[0m  ${m}`);
const info = (m) => console.log(`        ${m}`);

async function main() {
  console.log('\nLiveKit check\n');

  // ── Configured at all ─────────────────────────────────────────────────────
  if (!env.livekit.configured) {
    bad('LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET must all be set');
    process.exit(1);
  }
  ok(`url    ${env.livekit.url}`);
  ok(`key    ${env.livekit.apiKey}`);

  if (env.livekit.apiSecret.includes('PASTE_YOUR')) {
    bad('the secret is still the placeholder — paste the real one into .env');
    info('LiveKit shows it once, at creation. If it is lost, revoke the key');
    info('and issue a new one from the project dashboard.');
    process.exit(1);
  }
  ok(`secret ${env.livekit.apiSecret.length} characters`);

  if (env.livekit.url.startsWith('ws://')) {
    bad('LIVEKIT_URL is ws:// — LiveKit Cloud is wss://, and production refuses ws://');
    process.exit(1);
  }

  // ── The credentials are real ──────────────────────────────────────────────
  //
  // `listRooms` is the cheapest authenticated call there is. It is also the
  // only way to find out that the secret is wrong: signing a token is local
  // arithmetic and succeeds with any string at all.
  const host = env.livekit.url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  const svc = new RoomServiceClient(host, env.livekit.apiKey, env.livekit.apiSecret);

  try {
    const rooms = await svc.listRooms();
    ok(`authenticated — ${rooms.length} room${rooms.length === 1 ? '' : 's'} open right now`);
  } catch (err) {
    bad(`LiveKit refused the credentials: ${err.message}`);
    info('A 401 here means the key and secret do not match the project.');
    process.exit(1);
  }

  // ── A join token, the way a real call mints one ───────────────────────────
  const token = new AccessToken(env.livekit.apiKey, env.livekit.apiSecret, {
    identity: 'vybli-preflight',
    ttl: 60,
  });
  token.addGrant({ room: 'vybli-preflight', roomJoin: true, canPublish: true });
  const jwt = await token.toJwt();
  ok(`join token minted (${jwt.length} chars)`);

  console.log('\n  Calling is ready. Audio and video will carry.\n');
}

main().catch((err) => {
  bad(err.message);
  process.exit(1);
});
