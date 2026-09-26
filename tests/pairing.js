'use strict';

/**
 * "Show All Users" — the pairing rule, with no server or database.
 *
 *   npm run test:pairing
 *
 * Everything that decides who may see, chat with and call whom goes through
 * `utils/pairing`, so this checks that rule directly, plus the two places that
 * turn it into something a client sees: the discovery `where` and the
 * serializer's `can_interact` and rates. The end-to-end flows (the guards
 * refusing a same-side chat or call, the free call) are in `e2e.js`, which
 * needs a running server.
 */

const assert = require('node:assert/strict');
const { isSameSide, canPair, pairableWhere } = require('../src/utils/pairing');
const serialize = require('../src/utils/serialize');

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${label}\n      ${error.message.split('\n').join('\n      ')}`);
  }
}

function person(id, { earner, showAll = false } = {}) {
  return {
    id,
    createdAt: new Date(),
    profile: {
      name: id,
      isEarner: earner,
      voiceRatePerMinute: 12,
      videoRatePerMinute: 20,
    },
    privacySettings: { showAllUsers: showAll },
    languages: [],
  };
}

const man = (id, showAll) => person(id, { earner: false, showAll });
const woman = (id, showAll) => person(id, { earner: true, showAll });

console.log('\n── Show All Users: OFF (default) ───────────────────────────');

check('opposite sides always pair', () => {
  assert.equal(canPair(man('m'), woman('w')), true);
  assert.equal(canPair(woman('w'), man('m')), true);
});

check('same side does not pair', () => {
  assert.equal(canPair(man('a'), man('b')), false);
  assert.equal(canPair(woman('a'), woman('b')), false);
});

check('missing privacy row reads as OFF', () => {
  const a = man('a');
  const b = man('b', true);
  delete a.privacySettings;
  assert.equal(canPair(a, b), false);
});

check('discovery shows the opposite side only', () => {
  assert.deepEqual(pairableWhere(man('m')), { profile: { isEarner: true } });
  assert.deepEqual(pairableWhere(woman('w')), { profile: { isEarner: false } });
});

console.log('\n── Show All Users: ON ──────────────────────────────────────');

check('same side pairs when both have it on', () => {
  assert.equal(canPair(man('a', true), man('b', true)), true);
  assert.equal(canPair(woman('a', true), woman('b', true)), true);
});

check('same side needs it on for both, not one', () => {
  assert.equal(canPair(man('a', true), man('b', false)), false);
  assert.equal(canPair(man('a', false), man('b', true)), false);
});

check('opposite sides still pair, whatever either setting', () => {
  assert.equal(canPair(man('m', true), woman('w', false)), true);
  assert.equal(canPair(woman('w', true), man('m', false)), true);
});

check('discovery adds same-side people who also have it on', () => {
  assert.deepEqual(pairableWhere(man('m', true)), {
    OR: [
      { profile: { isEarner: true } },
      { profile: { isEarner: false }, privacySettings: { showAllUsers: true } },
    ],
  });
  assert.deepEqual(pairableWhere(woman('w', true)), {
    OR: [
      { profile: { isEarner: false } },
      { profile: { isEarner: true }, privacySettings: { showAllUsers: true } },
    ],
  });
});

console.log('\n── Serializer ──────────────────────────────────────────────');

function card(target, viewer) {
  return serialize.publicUser(target, {
    viewer: viewer.id,
    viewerProfile: viewer.profile,
    viewerPrivacy: viewer.privacySettings,
  });
}

check('can_interact follows the rule', () => {
  assert.equal(card(woman('w'), man('m')).can_interact, true);
  assert.equal(card(man('b'), man('a')).can_interact, false);
  assert.equal(card(man('b', true), man('a', true)).can_interact, true);
  assert.equal(card(man('b', false), man('a', true)).can_interact, false);
});

check('the other person\'s own switch is never sent', () => {
  const body = card(man('b', true), man('a', true));
  assert.equal('show_all_users' in body, false);
});

check('opposite-side rates are unchanged', () => {
  const body = card(woman('w'), man('m'));
  assert.equal(body.voice_rate_per_minute, 12);
  assert.equal(body.video_rate_per_minute, 20);
});

check('same-side cards quote no price', () => {
  assert.equal(card(man('b', true), man('a', true)).voice_rate_per_minute, 0);
  assert.equal(card(woman('b', true), woman('a', true)).voice_rate_per_minute, 0);
});

check('chat and call peers quote no price between two earners', () => {
  const summary = serialize.userSummary(woman('b', true), { viewer: woman('a', true) });
  assert.equal(summary.voice_rate_per_minute, 0);
  assert.equal(summary.can_interact, true);
});

check('chat and call peers keep the earner rate for the other side', () => {
  const summary = serialize.userSummary(woman('w'), { viewer: man('m') });
  assert.equal(summary.voice_rate_per_minute, 12);
  assert.equal(summary.can_interact, true);
});

check('no viewer means no answer, and the old rate rule', () => {
  const summary = serialize.userSummary(woman('w'));
  assert.equal(summary.can_interact, null);
  assert.equal(summary.voice_rate_per_minute, 12);
});

check('privacy settings carry the switch, off by default', () => {
  assert.equal(serialize.privacySettings({}).show_all_users, false);
  assert.equal(serialize.privacySettings({ showAllUsers: true }).show_all_users, true);
});

check('isSameSide is role, not position', () => {
  assert.equal(isSameSide(man('a'), man('b')), true);
  assert.equal(isSameSide(man('a'), woman('b')), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
