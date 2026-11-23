'use strict';

/**
 * Disconnected calls: which endings count, who they are attributed to, that
 * a duplicated end event counts once, that nothing is sent to an app, and the
 * figures the admin page is drawn from. No server or database: Prisma is
 * replaced by an in-memory stand-in for the handful of calls the two services
 * make.
 *
 *   npm run test:call-disconnects
 */

const assert = require('assert');
const Module = require('module');

// ── An in-memory Prisma, just enough for the two services ───────────────────

const db = { rows: [], users: new Map() };

const idMatch = (value, cond) =>
  cond === undefined || (typeof cond === 'string' ? value === cond : cond.in.includes(value));

function matches(row, where = {}) {
  if (!idMatch(row.userId, where.userId)) return false;
  if (!idMatch(row.byUserId, where.byUserId)) return false;
  if (where.type && row.type !== where.type) return false;
  if (where.reason && row.reason !== where.reason) return false;
  if (where.createdAt?.gte && !(row.createdAt >= where.createdAt.gte)) return false;
  if (where.durationSeconds?.lt != null && !(row.durationSeconds < where.durationSeconds.lt)) {
    return false;
  }
  if (where.OR && !where.OR.some((w) => matches(row, w))) return false;
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
    groupBy: async ({ by, where }) => {
      const groups = new Map();
      for (const r of db.rows.filter((x) => matches(x, where))) {
        const k = by.map((f) => r[f]).join('|');
        const g = groups.get(k) ?? [];
        g.push(r);
        groups.set(k, g);
      }
      return [...groups.values()].map((rows) => ({
        ...Object.fromEntries(by.map((f) => [f, rows[0][f]])),
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
  user: {
    findMany: async ({ where }) => {
      const all = [...db.users.values()];
      if (where.id) return all.filter((u) => where.id.in.includes(u.id));
      // The name-or-number search.
      const phone = where.OR[0].phone.contains;
      const name = where.OR[1].profile.name.contains.toLowerCase();
      return all.filter(
        (u) => u.phone.includes(phone) || (u.profile?.name ?? '').toLowerCase().includes(name)
      );
    },
  },
};

const toAdmin = [];
const toUsers = [];
const realLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request.endsWith('config/prisma')) return fakePrisma;
  if (request.endsWith('sockets/bus')) {
    return {
      emitToAdmin: (event, payload) => toAdmin.push({ event, payload }),
      emitToUser: (userId, event, payload) => toUsers.push({ userId, event, payload }),
      emitToUsers: (ids, event, payload) => toUsers.push({ ids, event, payload }),
    };
  }
  if (request.endsWith('config/avatarCatalog')) return { urlFor: (id) => (id ? `/a/${id}` : null) };
  return realLoad.call(this, request, ...rest);
};

const disconnects = require('../src/services/disconnect.service');
const admin = require('../src/services/admin/disconnects.service');

// ── Fixtures ────────────────────────────────────────────────────────────────

const woman = (id) => ({ id, profile: { gender: 'female' } });
const man = (id) => ({ id, profile: { gender: 'male' } });
const HER = woman('her');
const minsAgo = (m) => new Date(Date.now() - m * 60 * 1000);

function account(id, name, gender, extra = {}) {
  db.users.set(id, {
    id,
    dialCode: '+91',
    phone: `90000${id.replace(/\D/g, '').padStart(5, '0')}`,
    deletedAt: null,
    profile: { name, avatarId: null, gender },
    ...extra,
  });
}

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

/** [by] ends a call on [on] after [seconds], [ago] minutes ago. */
const cut = (by, on, seconds, ago, extra = {}) =>
  disconnects.record({
    call: call({ caller: man(by), callee: woman(on), seconds, endedAt: minsAgo(ago), ...extra }),
    endedById: by,
    reason: extra.reason ?? 'hungUp',
  });

let passed = 0;
async function test(name, fn) {
  db.rows.length = 0;
  db.users.clear();
  toAdmin.length = 0;
  toUsers.length = 0;
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ── Tests ───────────────────────────────────────────────────────────────────

(async () => {
  console.log('Recording a disconnect');

  await test('a man hanging up on a live call is recorded against him', async () => {
    const c = call({ caller: man('m1'), callee: HER, seconds: 42, type: 'video' });
    assert.strictEqual(await disconnects.record({ call: c, endedById: 'm1', reason: 'hungUp' }), true);
    assert.strictEqual(db.rows.length, 1);
    const { id: _id, createdAt: _at, ...row } = db.rows[0];
    assert.deepStrictEqual(row, {
      callId: c.id,
      userId: 'her',
      byUserId: 'm1',
      type: 'video',
      reason: 'hungUp',
      durationSeconds: 42,
    });
  });

  await test('it tells the admin feed, and no app at all', async () => {
    const c = call({ caller: man('m1'), callee: HER, seconds: 42 });
    await disconnects.record({ call: c, endedById: 'm1', reason: 'hungUp' });
    assert.deepStrictEqual(toAdmin, [
      {
        event: 'admin:call_disconnected',
        payload: {
          call_id: c.id,
          by_user_id: 'm1',
          user_id: 'her',
          type: 'voice',
          reason: 'hungUp',
          duration_seconds: 42,
        },
      },
    ]);
    assert.deepStrictEqual(toUsers, []);
  });

  await test('it counts whichever of them dialled', async () => {
    const c = call({ caller: HER, callee: man('m1') });
    assert.strictEqual(await disconnects.record({ call: c, endedById: 'm1', reason: 'hungUp' }), true);
  });

  await test('his connection dropping counts too', async () => {
    const c = call({ caller: man('m1'), callee: HER });
    await disconnects.record({ call: c, endedById: 'm1', reason: 'networkError' });
    assert.strictEqual(db.rows[0].reason, 'networkError');
  });

  await test('a call she ended herself is not a disconnect', async () => {
    const c = call({ caller: man('m1'), callee: HER });
    assert.strictEqual(await disconnects.record({ call: c, endedById: 'her', reason: 'hungUp' }), false);
    assert.strictEqual(db.rows.length, 0);
    assert.strictEqual(toAdmin.length, 0);
  });

  await test('a call between two men is not recorded — this is about earners', async () => {
    const c = call({ caller: man('m1'), callee: man('m2') });
    assert.strictEqual(await disconnects.record({ call: c, endedById: 'm1', reason: 'hungUp' }), false);
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
    assert.strictEqual(await disconnects.record({ call: c, endedById: 'm1', reason: 'hungUp' }), false);
    assert.strictEqual(db.rows.length, 1);
    assert.strictEqual(toAdmin.length, 1);
  });

  console.log('\nThe admin page');

  /** Arun cuts three calls (two women), Vikram one, and one is 40 days old. */
  async function seed() {
    account('m1', 'Arun', 'male');
    account('m2', 'Vikram', 'male');
    account('w1', 'Priya', 'female');
    account('w2', 'Divya', 'female');
    await cut('m1', 'w1', 30, 50);
    await cut('m1', 'w1', 90, 40);
    await cut('m1', 'w2', 20, 10, { type: 'video' });
    await cut('m2', 'w2', 300, 5, { reason: 'networkError' });
    // m3 has closed their account — there is no user row left to read.
    await cut('m3', 'w1', 10, 60 * 24 * 40);
  }

  await test('the summary adds the period up', async () => {
    await seed();
    const month = await admin.overview({ days: 30 });
    assert.strictEqual(month.days, 30);
    assert.strictEqual(month.frequent_at, 3);
    assert.deepStrictEqual(month.summary, {
      total_disconnected: 4,
      unique_users: 2,
      frequent_users: 1,
      earners_affected: 2,
      avg_duration_seconds: 110,
      quick_disconnects: 2,
      hung_up: 3,
      connection_lost: 1,
    });

    const all = await admin.overview({ days: 0 });
    assert.strictEqual(all.days, 0);
    assert.strictEqual(all.summary.total_disconnected, 5);
    assert.strictEqual(all.summary.unique_users, 3);
  });

  await test('who disconnected is ranked, with how many women and how quick', async () => {
    await seed();
    const { total, items } = await admin.users({ days: 30 });
    assert.strictEqual(total, 2);
    assert.deepStrictEqual(
      items.map((i) => [
        i.user.id,
        i.user.name,
        i.count,
        i.earners_affected,
        i.quick_disconnects,
        i.avg_duration_seconds,
        i.frequent,
      ]),
      [
        ['m1', 'Arun', 3, 2, 2, 47, true],
        ['m2', 'Vikram', 1, 1, 0, 300, false],
      ]
    );
    assert.strictEqual(items[0].user.phone, '+91 9000000001');
  });

  await test('it narrows to the frequent, searches by name, and pages', async () => {
    await seed();
    const frequent = await admin.users({ days: 30, frequent: true });
    assert.deepStrictEqual(frequent.items.map((i) => i.user.id), ['m1']);

    const found = await admin.users({ days: 30, search: 'vik' });
    assert.deepStrictEqual(found.items.map((i) => i.user.id), ['m2']);

    const second = await admin.users({ days: 30, skip: 1, take: 1 });
    assert.strictEqual(second.total, 2);
    assert.deepStrictEqual(second.items.map((i) => i.user.id), ['m2']);
  });

  await test('someone who closed their account still counts, unnamed', async () => {
    await seed();
    const { items } = await admin.users({ days: 0 });
    const gone = items.find((i) => i.user.id === 'm3');
    assert.strictEqual(gone.count, 1);
    assert.strictEqual(gone.user.name, null);
    assert.strictEqual(gone.user.deleted, true);
  });

  await test('the history is newest first, with both people on each row', async () => {
    await seed();
    const { total, items } = await admin.history({ days: 30, take: 2 });
    assert.strictEqual(total, 4);
    assert.deepStrictEqual(
      items.map((i) => [i.by.name, i.earner.name, i.type, i.reason, i.duration_seconds, i.quick]),
      [
        ['Vikram', 'Divya', 'voice', 'networkError', 300, false],
        ['Arun', 'Divya', 'video', 'hungUp', 20, true],
      ]
    );
  });

  await test('the history filters by person, earner, type, reason and search', async () => {
    await seed();
    const count = async (filter) => (await admin.history({ days: 30, ...filter })).total;
    assert.strictEqual(await count({ byUserId: 'm1' }), 3);
    assert.strictEqual(await count({ earnerId: 'w1' }), 2);
    assert.strictEqual(await count({ type: 'video' }), 1);
    assert.strictEqual(await count({ reason: 'networkError' }), 1);
    // A search matches either side of the call.
    assert.strictEqual(await count({ search: 'divya' }), 2);
    assert.strictEqual(await count({ search: 'arun' }), 3);
    assert.strictEqual(await count({ search: 'nobody' }), 0);
  });

  console.log(`\n${passed} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
