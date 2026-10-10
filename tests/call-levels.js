'use strict';

/**
 * Level-based call pricing: the ladder, prices for every pairing, and the
 * counting that raises a woman's level — idempotent, once per man, and voice
 * and video kept apart. No server or database: Prisma is replaced by an
 * in-memory stand-in for the handful of calls the counting makes.
 *
 *   npm run test:call-levels
 */

const assert = require('assert');
const Module = require('module');

// ── An in-memory Prisma, just enough for `pricing.recordCall` ───────────────

const db = {
  calls: new Map(),
  callers: new Set(),
  stats: new Map(),
  profiles: new Map(),
  changes: [],
};
const key = (...parts) => parts.join('|');

const fakePrisma = {
  call: {
    updateMany: async ({ where, data }) => {
      const row = db.calls.get(where.id);
      if (!row || row.statsCountedAt !== null) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  },
  earnerCaller: {
    createMany: async ({ data }) => {
      let count = 0;
      for (const r of data) {
        const k = key(r.earnerId, r.callerId, r.type);
        if (!db.callers.has(k)) {
          db.callers.add(k);
          count += 1;
        }
      }
      return { count };
    },
  },
  earnerCallStats: {
    upsert: async ({ where, create, update }) => {
      const k = key(where.userId_type.userId, where.userId_type.type);
      const row = db.stats.get(k);
      if (!row) {
        const fresh = { ...create };
        db.stats.set(k, fresh);
        return { ...fresh };
      }
      row.billableSeconds += update.billableSeconds.increment;
      row.uniqueCallers += update.uniqueCallers.increment;
      row.countedCalls += update.countedCalls.increment;
      return { ...row };
    },
  },
  userProfile: {
    findUnique: async ({ where }) => {
      const p = db.profiles.get(where.userId);
      return p ? { ...p } : null;
    },
    updateMany: async ({ where, data }) => {
      const p = db.profiles.get(where.userId);
      const field = Object.keys(data)[0];
      if (!p || p[field] !== where[field]) return { count: 0 };
      p[field] = data[field];
      return { count: 1 };
    },
  },
  earnerLevelChange: {
    create: async ({ data }) => {
      const row = { id: `c${db.changes.length + 1}`, createdAt: new Date(), ...data };
      db.changes.push(row);
      return row;
    },
  },
  callLevel: { findMany: async () => db.levelRows ?? [] },
  pricingSettings: { findUnique: async () => ({ earnerShare: 0.3 }) },
  $transaction: async (fn) => fn(fakePrisma),
};

const announced = [];
const realLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request.endsWith('config/prisma')) return fakePrisma;
  if (request.endsWith('sockets/bus')) {
    return {
      emitToUser: (userId, event, payload) => announced.push({ userId, event, payload }),
      emitToUsers: () => {},
      emitToPresenceWatchers: () => {},
      emitToAdmin: () => {},
    };
  }
  if (request.endsWith('relationship.service')) {
    return { conversationPeerIdsFor: async () => new Set() };
  }
  if (request.endsWith('notification.service')) return { notify: async () => null };
  return realLoad.call(this, request, ...rest);
};

const pricing = require('../src/services/pricing.service');
const callPricing = require('../src/utils/callPricing');

// ── Harness ─────────────────────────────────────────────────────────────────

let passed = 0;
const pending = [];
function test(label, fn) {
  pending.push(async () => {
    reset();
    await fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  });
}

function reset() {
  db.calls.clear();
  db.callers.clear();
  db.stats.clear();
  db.profiles.clear();
  db.changes.length = 0;
  announced.length = 0;
  db.profiles.set('her', { userId: 'her', gender: 'female', voiceLevel: 1, videoLevel: 1 });
}

let nextCall = 0;
/** A paid, ended call from [callerId] to her, of [minutes]. */
function paidCall(callerId, { type = 'voice', minutes = 10, amount = 30 } = {}) {
  nextCall += 1;
  const call = {
    id: `call${nextCall}`,
    type,
    status: 'ended',
    durationSeconds: minutes * 60,
    amountSpent: amount,
    statsCountedAt: null,
  };
  db.calls.set(call.id, call);
  return call;
}

const record = (call, payerId) =>
  pricing.recordCall({ call, holderId: 'her', payerId, audience: 'female' });

const stat = (type) => db.stats.get(key('her', type));
const HOUR = 3600;

// ── The ladder ──────────────────────────────────────────────────────────────

console.log('\nCall levels\n');

test('the launch ladder: six levels each, Starter needs nothing', () => {
  for (const [audience, type] of [
    ['female', 'voice'], ['female', 'video'], ['male', 'voice'], ['male', 'video'],
  ]) {
    const ladder = pricing.ladderFor(audience, type);
    assert.strictEqual(ladder.length, 6);
    assert.deepStrictEqual(ladder.map((l) => l.name), [
      'Starter', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Elite',
    ]);
    assert.strictEqual(ladder[0].minSeconds, 0);
    assert.strictEqual(ladder[0].minUniqueCallers, 0);
  }
  for (const audience of ['female', 'male']) {
    assert.deepStrictEqual(pricing.ladderFor(audience, 'voice').map((l) => l.ratePerMinute), [3, 4, 5, 6, 7, 8]);
    assert.deepStrictEqual(pricing.ladderFor(audience, 'video').map((l) => l.ratePerMinute), [7, 9, 12, 15, 18, 20]);
  }
});

test('both requirements are needed — hours alone or callers alone are not enough', () => {
  // Silver voice: 3 hours and 5 callers.
  assert.strictEqual(pricing.qualifiedLevel('female', 'voice', { seconds: 50 * HOUR, uniqueCallers: 4 }), 1);
  assert.strictEqual(pricing.qualifiedLevel('female', 'voice', { seconds: 2 * HOUR, uniqueCallers: 500 }), 1);
  assert.strictEqual(pricing.qualifiedLevel('female', 'voice', { seconds: 3 * HOUR, uniqueCallers: 5 }), 2);
  assert.strictEqual(pricing.qualifiedLevel('female', 'voice', { seconds: 100 * HOUR, uniqueCallers: 100 }), 6);
  // Video Gold: 6 hours and 10 callers.
  assert.strictEqual(pricing.qualifiedLevel('female', 'video', { seconds: 6 * HOUR, uniqueCallers: 10 }), 3);
});

// ── Prices ──────────────────────────────────────────────────────────────────

const man = { gender: 'male' };
const silverVoiceGoldVideo = { gender: 'female', voiceLevel: 2, videoLevel: 3 };

test("a man pays her level's price, whoever dialled", () => {
  const he = { callerProfile: man, calleeProfile: silverVoiceGoldVideo };
  const she = { callerProfile: silverVoiceGoldVideo, calleeProfile: man };
  assert.strictEqual(callPricing.listRate('voice', he), 4);
  assert.strictEqual(callPricing.listRate('video', he), 12);
  assert.strictEqual(callPricing.listRate('voice', she), 4);
  assert.strictEqual(callPricing.payerSide({ callerGender: 'female', calleeGender: 'male' }), 'callee');
});

test('a new woman is Starter: ₹3 voice, ₹7 video', () => {
  const p = { callerProfile: man, calleeProfile: { gender: 'female' } };
  assert.strictEqual(callPricing.listRate('voice', p), 3);
  assert.strictEqual(callPricing.listRate('video', p), 7);
});

test("a man calling a man pays the answering man's level price", () => {
  const goldVoiceMan = { gender: 'male', voiceLevel: 3, videoLevel: 1 };
  const men = { callerProfile: man, calleeProfile: goldVoiceMan };
  assert.strictEqual(callPricing.listRate('voice', men), 5);
  assert.strictEqual(callPricing.listRate('video', men), 7);
  // The caller's own level does not matter — the one answering prices it.
  const reverse = { callerProfile: goldVoiceMan, calleeProfile: man };
  assert.strictEqual(callPricing.listRate('voice', reverse), 3);
  assert.strictEqual(callPricing.payerSide({ callerGender: 'male', calleeGender: 'male' }), 'caller');
  assert.deepStrictEqual(
    callPricing.pricedBy({ callerGender: 'male', calleeGender: 'male' }),
    { audience: 'male', holder: 'callee' }
  );
});

test('women with women stay free, and are priced by nobody', () => {
  const women = { callerProfile: silverVoiceGoldVideo, calleeProfile: silverVoiceGoldVideo };
  assert.strictEqual(callPricing.ratePerMinute('voice', women), 0);
  assert.strictEqual(callPricing.pricedBy({ callerGender: 'female', calleeGender: 'female' }), null);
});

test('a man and a woman are always priced by her, whoever dialled', () => {
  assert.deepStrictEqual(
    callPricing.pricedBy({ callerGender: 'female', calleeGender: 'male' }),
    { audience: 'female', holder: 'caller' }
  );
  assert.deepStrictEqual(
    callPricing.pricedBy({ callerGender: 'male', calleeGender: 'female' }),
    { audience: 'female', holder: 'callee' }
  );
});

test("a man is quoted another man's level price; a woman is quoted nothing", () => {
  const diamondMan = { gender: 'male', voiceLevel: 5, videoLevel: 5 };
  assert.strictEqual(callPricing.quotedRate('voice', { viewerProfile: man, peerProfile: diamondMan }), 7);
  assert.strictEqual(callPricing.quotedRate('video', { viewerProfile: man, peerProfile: diamondMan }), 18);
  assert.strictEqual(
    callPricing.quotedRate('voice', { viewerProfile: silverVoiceGoldVideo, peerProfile: diamondMan }),
    0
  );
});

test('VIP discount comes off her price', () => {
  const rate = callPricing.ratePerMinute('video', {
    callerProfile: man,
    calleeProfile: silverVoiceGoldVideo,
    discountPct: 10,
  });
  assert.strictEqual(rate, 10.8);
});

test('the quote on her card is the billed price; a woman is quoted nothing', () => {
  assert.strictEqual(
    callPricing.quotedRate('voice', { viewerProfile: man, peerProfile: silverVoiceGoldVideo }),
    4
  );
  assert.strictEqual(
    callPricing.quotedRate('voice', { viewerProfile: silverVoiceGoldVideo, peerProfile: man }),
    0
  );
});

test('the earner share is 30% at launch', () => {
  assert.strictEqual(pricing.earnerShare(), 0.3);
});

// ── Counting ────────────────────────────────────────────────────────────────

test('a repeat caller adds minutes but counts once', async () => {
  await record(paidCall('m1', { minutes: 10 }), 'm1');
  await record(paidCall('m1', { minutes: 20 }), 'm1');
  await record(paidCall('m2', { minutes: 5 }), 'm2');
  assert.strictEqual(stat('voice').billableSeconds, 35 * 60);
  assert.strictEqual(stat('voice').uniqueCallers, 2);
  assert.strictEqual(stat('voice').countedCalls, 3);
});

test('the same call ending twice counts once', async () => {
  const call = paidCall('m1', { minutes: 10 });
  await record(call, 'm1');
  await record(call, 'm1');
  await record({ ...call }, 'm1');
  assert.strictEqual(stat('voice').billableSeconds, 10 * 60);
  assert.strictEqual(stat('voice').countedCalls, 1);
});

test('unpaid, unfinished and free calls count nothing', async () => {
  const free = paidCall('m1', { amount: 0 });
  const missed = { ...paidCall('m1'), status: 'missed' };
  db.calls.set(missed.id, missed);
  await record(free, 'm1');
  await record(missed, 'm1');
  await pricing.recordCall({ call: paidCall('m1'), earnerId: 'her', payerId: null });
  assert.strictEqual(stat('voice'), undefined);
});

test('voice never moves video, and video never moves voice', async () => {
  for (let i = 0; i < 5; i += 1) await record(paidCall(`m${i}`, { minutes: 40 }), `m${i}`);
  assert.strictEqual(db.profiles.get('her').voiceLevel, 2);
  assert.strictEqual(db.profiles.get('her').videoLevel, 1);
  assert.strictEqual(stat('video'), undefined);
  // The same men on video are new video callers.
  await record(paidCall('m0', { type: 'video', minutes: 1 }), 'm0');
  assert.strictEqual(stat('video').uniqueCallers, 1);
  assert.strictEqual(stat('voice').uniqueCallers, 5);
});

test('levelling up records the change and tells her', async () => {
  for (let i = 0; i < 4; i += 1) await record(paidCall(`m${i}`, { minutes: 50 }), `m${i}`);
  assert.strictEqual(db.profiles.get('her').voiceLevel, 1, 'four callers is not five');
  await record(paidCall('m4', { minutes: 1 }), 'm4');
  assert.strictEqual(db.profiles.get('her').voiceLevel, 2);
  assert.strictEqual(db.changes.length, 1);
  assert.deepStrictEqual(
    [db.changes[0].fromLevel, db.changes[0].toLevel, db.changes[0].source],
    [1, 2, 'auto']
  );
  assert.strictEqual(Number(db.changes[0].toRate), 4);
  // Names are stored with the change, so renaming a level later cannot
  // rewrite this row.
  assert.deepStrictEqual([db.changes[0].fromName, db.changes[0].toName], ['Starter', 'Silver']);
  assert.ok(announced.some((a) => a.event === 'levels:updated' && a.payload.level === 2));
});

test('can skip levels in one go when a call clears several', async () => {
  // 10 hours and 15 callers is Gold — straight from Starter.
  for (let i = 0; i < 14; i += 1) await record(paidCall(`m${i}`, { minutes: 1 }), `m${i}`);
  await record(paidCall('m14', { minutes: 10 * 60 }), 'm14');
  assert.strictEqual(db.profiles.get('her').voiceLevel, 3);
  assert.strictEqual(db.changes.at(-1).fromLevel, 1);
});

test('two calls ending together record one upgrade, not two', async () => {
  for (let i = 0; i < 4; i += 1) await record(paidCall(`m${i}`, { minutes: 50 }), `m${i}`);
  await Promise.all([
    record(paidCall('m4', { minutes: 1 }), 'm4'),
    record(paidCall('m5', { minutes: 1 }), 'm5'),
  ]);
  assert.strictEqual(db.profiles.get('her').voiceLevel, 2);
  assert.strictEqual(db.changes.filter((c) => c.toLevel === 2).length, 1);
});

test('a level is never lowered by counting', async () => {
  db.profiles.get('her').voiceLevel = 4; // set by an admin
  await record(paidCall('m1', { minutes: 1 }), 'm1');
  assert.strictEqual(db.profiles.get('her').voiceLevel, 4);
  assert.strictEqual(db.changes.length, 0);
});

test("men's levels rise from men's calls, on the men's ladder", async () => {
  db.profiles.set('him', { userId: 'him', gender: 'male', voiceLevel: 1, videoLevel: 1 });
  for (let i = 0; i < 5; i += 1) {
    await pricing.recordCall({
      call: paidCall(`m${i}`, { minutes: 40 }),
      holderId: 'him',
      payerId: `m${i}`,
      audience: 'male',
    });
  }
  assert.strictEqual(db.profiles.get('him').voiceLevel, 2);
  assert.strictEqual(db.profiles.get('her').voiceLevel, 1, "her level is untouched");
  assert.strictEqual(db.changes.at(-1).userId, 'him');
});

test("nobody's own calls count towards their own level", async () => {
  await pricing.recordCall({
    call: paidCall('her', { minutes: 60 }),
    holderId: 'her',
    payerId: 'her',
    audience: 'female',
  });
  assert.strictEqual(stat('voice'), undefined);
});

test("a changed men's ladder changes men's prices, never women's", async () => {
  // The table as `updateLadder` would leave it after a men's voice edit.
  const launch = pricing.DEFAULT_LADDER;
  db.levelRows = [];
  for (const audience of ['female', 'male']) {
    for (const type of ['voice', 'video']) {
      for (const step of launch[audience][type]) {
        const bump = audience === 'male' && type === 'voice' ? 10 : 0;
        db.levelRows.push({ audience, type, ...step, ratePerMinute: step.ratePerMinute + bump });
      }
    }
  }
  await pricing.load();
  try {
    assert.deepStrictEqual(pricing.ladderFor('male', 'voice').map((l) => l.ratePerMinute), [13, 14, 15, 16, 17, 18]);
    assert.deepStrictEqual(pricing.ladderFor('female', 'voice').map((l) => l.ratePerMinute), [3, 4, 5, 6, 7, 8]);
    assert.strictEqual(
      callPricing.listRate('voice', { callerProfile: man, calleeProfile: { gender: 'female' } }),
      3
    );
    assert.strictEqual(
      callPricing.listRate('voice', { callerProfile: man, calleeProfile: { gender: 'male' } }),
      13
    );
  } finally {
    db.levelRows = [];
    await pricing.load();
  }
});

// ── Run ─────────────────────────────────────────────────────────────────────

(async () => {
  for (const run of pending) await run();
  console.log(`\n${passed} passed\n`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
