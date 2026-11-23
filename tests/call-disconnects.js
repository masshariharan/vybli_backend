'use strict';

/**
 * Disconnected calls: which endings count, who they are attributed to, that
 * a duplicated end event counts once, and the figures the screen is drawn
 * from. No server or database: Prisma is replaced by an in-memory stand-in
 * for the handful of calls `disconnect.service` makes.
 *
 *   npm run test:call-disconnects
 */

const assert = require('assert');
const Module = require('module');

// ── An in-memory Prisma, just enough for `disconnect.service` ───────────────

const db = { rows: [], profiles: new Map() };

function matches(row, where = {}) {
  if (where.userId && row.userId !== where.userId) return false;
  if (where.byUserId && row.byUserId !== where.byUserId) return false;
  if (where.createdAt?.gte && !(row.createdAt >= where.createdAt.gte)) return false;
  if (where.durationSeconds?.lt != null && !(row.durationSeconds < where.durationSeconds.lt)) {
    return false;
  }
  return true;
}
const avg = (rows) =>
  rows.length ? rows.reduce((n, r) => n + r.durationSeconds, 0) / rows.length : null;

const fakePrisma = {
  callDisconnect: {
    createMany: async ({ data }) => {
      let count = 0;
      for (const r of data) {
        if (db.rows.some((x) => x.callId === r.callId)) continue;
        db.rows.push({ id: `d${db.rows.length + 1}`, ...r });
        count += 1;
      }
      return { count };
    },
    aggregate: async ({ where }) => {
      const rows = db.rows.filter((r) => matches(r, where));
      return { _count: { _all: rows.length }, _avg: { durationSeconds: avg(rows) } };
    },
    count: async ({ where }) => db.rows.filter((r) => matches(r, where)).length,
    groupBy: async ({ where }) => {
      const groups = new Map();
      for (const r of db.rows.filter((x) => matches(x, where))) {
        const g = groups.get(r.byUserId) ?? [];
        g.push(r);
        groups.set(r.byUserId, g);
      }
      return [...groups].map(([byUserId, rows]) => ({
        byUserId,
        _count: { _all: rows.length },
        _avg: { durationSeconds: avg(rows) },
        _max: { createdAt: new Date(Math.max(...rows.map((r) => +r.createdAt))) },
      }));
    },
    findMany: async ({ where, skip = 0, take }) =>
      db.rows
        .filter((r) => matches(r, where))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(skip, take == null ? undefined : skip + take),
  },
  userProfile: {
    findMany: async ({ where }) =>
      where.userId.in.filter((id) => db.profiles.has(id)).map((id) => db.profiles.get(id)),
  },
};

const announced = [];
const realLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request.endsWith('config/prisma')) return fakePrisma;
  if (request.endsWith('sockets/bus')) {
    return { emitToUser: (userId, event, payload) => announced.push({ userId, event, payload }) };
  }
  if (request.endsWith('config/avatarCatalog')) return { urlFor: (id) => (id ? `/a/${id}` : null) };
  return realLoad.call(this, request, ...rest);
};

const disconnects = require('../src/services/disconnect.service');

// ── Fixtures ────────────────────────────────────────────────────────────────

const woman = (id) => ({ id, profile: { gender: 'female' } });
const man = (id) => ({ id, profile: { gender: 'male' } });
const HER = woman('her');
const minsAgo = (m) => new Date(Date.now() - m * 60 * 1000);

let seq = 0;
function call({ caller, callee, seconds = 120, endedAt = new Date(), ...rest }) {
  seq += 1;
  return {
    id: `c${seq}`,
    callerId: caller.id,
    calleeId: callee.id,
    caller,
    callee,
    type: 'voice',
    status: 'ended',
    connectedAt: new Date(endedAt - seconds * 1000),
    endedAt,
    durationSeconds: seconds,
    ...rest,
  };
}

let passed = 0;
async function test(name, fn) {
  db.rows.length = 0;
  db.profiles.clear();
  announced.length = 0;
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ── Tests ───────────────────────────────────────────────────────────────────

(async () => {
  console.log('Disconnected calls');

  await test('a man hanging up on a live call is recorded against him, for her', async () => {
    const c = call({ caller: man('m1'), callee: HER, seconds: 42, type: 'video' });
    const owner = await disconnects.record({ call: c, endedById: 'm1', reason: 'hungUp' });
    assert.strictEqual(owner, 'her');
    assert.strictEqual(db.rows.length, 1);
    assert.deepStrictEqual(
      { ...db.rows[0], id: undefined, createdAt: undefined },
      {
        id: undefined,
        callId: c.id,
        userId: 'her',
        byUserId: 'm1',
        type: 'video',
        reason: 'hungUp',
        durationSeconds: 42,
        createdAt: undefined,
      }
    );
    assert.deepStrictEqual(announced, [
      { userId: 'her', event: 'disconnects:updated', payload: { call_id: c.id } },
    ]);
  });

  await test('it counts whichever of them dialled', async () => {
    const c = call({ caller: HER, callee: man('m1') });
    assert.strictEqual(
      await disconnects.record({ call: c, endedById: 'm1', reason: 'hungUp' }),
      'her'
    );
  });

  await test('his connection dropping counts too', async () => {
    const c = call({ caller: man('m1'), callee: HER });
    await disconnects.record({ call: c, endedById: 'm1', reason: 'networkError' });
    assert.strictEqual(db.rows[0].reason, 'networkError');
  });

  await test('a call she ended herself is not a disconnect', async () => {
    const c = call({ caller: man('m1'), callee: HER });
    assert.strictEqual(
      await disconnects.record({ call: c, endedById: 'her', reason: 'hungUp' }),
      null
    );
    assert.strictEqual(db.rows.length, 0);
    assert.strictEqual(announced.length, 0);
  });

  await test('nothing is recorded for a man — the record is hers only', async () => {
    const c = call({ caller: man('m1'), callee: man('m2') });
    assert.strictEqual(
      await disconnects.record({ call: c, endedById: 'm1', reason: 'hungUp' }),
      null
    );
  });

  await test('endings nobody chose are not disconnects', async () => {
    const base = { caller: man('m1'), callee: HER };
    // Out of balance, and endings with nobody to attribute them to.
    await disconnects.record({ call: call(base), endedById: 'm1', reason: 'insufficientBalance' });
    await disconnects.record({ call: call(base), endedById: null, reason: 'networkError' });
    // Someone who was never on the call.
    await disconnects.record({ call: call(base), endedById: 'stranger', reason: 'hungUp' });
    // Never connected: a decline or a cancel, not a disconnect.
    await disconnects.record({
      call: call({ ...base, connectedAt: null, status: 'cancelled' }),
      endedById: 'm1',
      reason: 'cancelled',
    });
    await disconnects.record({
      call: call({ ...base, connectedAt: null }),
      endedById: 'm1',
      reason: 'hungUp',
    });
    assert.strictEqual(db.rows.length, 0);
  });

  await test('a duplicated end event is counted once', async () => {
    const c = call({ caller: man('m1'), callee: HER });
    await disconnects.record({ call: c, endedById: 'm1', reason: 'hungUp' });
    const again = await disconnects.record({ call: c, endedById: 'm1', reason: 'hungUp' });
    assert.strictEqual(again, null);
    assert.strictEqual(db.rows.length, 1);
    assert.strictEqual(announced.length, 1);
  });

  await test('the overview adds it up and ranks the people', async () => {
    db.profiles.set('m1', { userId: 'm1', name: 'Arun', avatarId: 'male_01' });
    db.profiles.set('m2', { userId: 'm2', name: 'Vikram', avatarId: null });
    const from = (id, seconds, ago) =>
      disconnects.record({
        call: call({ caller: man(id), callee: HER, seconds, endedAt: minsAgo(ago) }),
        endedById: id,
        reason: 'hungUp',
      });
    await from('m1', 30, 50);
    await from('m1', 90, 40);
    await from('m1', 20, 10);
    await from('m2', 300, 5);
    // m3 has closed their account — no profile.
    await from('m3', 10, 60 * 24 * 40); // 40 days ago
    // Another woman's record is not hers.
    await disconnects.record({
      call: call({ caller: man('m1'), callee: woman('other') }),
      endedById: 'm1',
      reason: 'hungUp',
    });

    const month = await disconnects.overview(HER, { range: '30d' });
    assert.deepStrictEqual(month.summary, {
      total_disconnected: 4,
      unique_users: 2,
      frequent_users: 1,
      quick_disconnects: 2,
      avg_duration_seconds: 110,
    });
    assert.deepStrictEqual(
      month.users.map((u) => [u.user_id, u.user_name, u.count, u.frequent, u.avg_duration_seconds]),
      [
        ['m1', 'Arun', 3, true, 47],
        ['m2', 'Vikram', 1, false, 300],
      ]
    );
    assert.strictEqual(month.users[0].avatar_url, '/a/male_01');
    assert.strictEqual(month.users[1].avatar_url, null);

    const all = await disconnects.overview(HER, { range: 'all' });
    assert.strictEqual(all.summary.total_disconnected, 5);
    assert.strictEqual(all.summary.unique_users, 3);
    assert.strictEqual(all.users[2].user_name, 'Unknown');
  });

  await test('the history is newest first, pages, and narrows to one person', async () => {
    db.profiles.set('m1', { userId: 'm1', name: 'Arun', avatarId: 'male_01' });
    for (const [id, ago, seconds] of [
      ['m1', 30, 45],
      ['m2', 20, 200],
      ['m1', 10, 75],
    ]) {
      await disconnects.record({
        call: call({ caller: man(id), callee: HER, seconds, endedAt: minsAgo(ago) }),
        endedById: id,
        reason: 'hungUp',
      });
    }

    const page = await disconnects.history(HER, { range: '30d', skip: 0, take: 2 });
    assert.strictEqual(page.total, 3);
    assert.deepStrictEqual(
      page.items.map((i) => [i.user_id, i.duration_seconds, i.quick]),
      [
        ['m1', 75, false],
        ['m2', 200, false],
      ]
    );

    const his = await disconnects.history(HER, { range: '30d', userId: 'm1', skip: 0, take: 20 });
    assert.strictEqual(his.total, 2);
    assert.ok(his.items.every((i) => i.user_name === 'Arun'));
    assert.strictEqual(his.items[1].quick, true);
  });

  await test('both reads refuse anyone who is not a woman', async () => {
    for (const read of [disconnects.overview, disconnects.history]) {
      await assert.rejects(
        () => read(man('m1'), {}),
        (err) => err.code === 'WOMEN_ONLY' && err.status === 403
      );
    }
  });

  console.log(`\n${passed} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
