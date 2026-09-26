'use strict';

/**
 * `utils/paging.pageAcrossBuckets`, with no database.
 *
 *   npm run test:paging
 *
 * A fake delegate stands in for a Prisma model: each bucket is a list, and
 * `count`/`findMany` read it. What matters is the property lazy loading
 * relies on — walking the pages in order yields every row exactly once, in
 * the buckets' order, whatever the page size.
 */

const assert = require('node:assert/strict');
const { pageAcrossBuckets } = require('../src/utils/paging');

let passed = 0;
let failed = 0;

async function check(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${label}\n      ${error.message.split('\n').join('\n      ')}`);
  }
}

/** Buckets keyed by `where.bucket`; counts every read so cost can be checked. */
function fakeDelegate(data) {
  const calls = { count: 0, findMany: 0 };
  return {
    calls,
    count: async ({ where }) => {
      calls.count += 1;
      return data[where.bucket].length;
    },
    findMany: async ({ where, skip, take }) => {
      calls.findMany += 1;
      return data[where.bucket].slice(skip, skip + take);
    },
  };
}

const buckets = (names) => names.map((bucket) => ({ where: { bucket }, orderBy: [] }));

async function walk(delegate, names, size) {
  const seen = [];
  for (let page = 1; ; page += 1) {
    const { rows, total } = await pageAcrossBuckets(delegate, {
      buckets: buckets(names),
      skip: (page - 1) * size,
      take: size,
    });
    seen.push(...rows);
    if (seen.length >= total || rows.length === 0) return { seen, total };
  }
}

(async () => {
  console.log('\n── pageAcrossBuckets ───────────────────────────────────────');

  const data = {
    online: ['o1', 'o2', 'o3'],
    busy: ['b1'],
    offline: ['f1', 'f2', 'f3', 'f4', 'f5'],
  };
  const all = [...data.online, ...data.busy, ...data.offline];

  for (const size of [1, 2, 3, 4, 5, 20]) {
    await check(`page size ${size}: every row once, buckets in order`, async () => {
      const { seen, total } = await walk(fakeDelegate(data), ['online', 'busy', 'offline'], size);
      assert.equal(total, all.length);
      assert.deepEqual(seen, all);
    });
  }

  await check('a page spanning two buckets reads only those two', async () => {
    const d = fakeDelegate(data);
    const { rows } = await pageAcrossBuckets(d, {
      buckets: buckets(['online', 'busy', 'offline']),
      skip: 2,
      take: 3,
    });
    assert.deepEqual(rows, ['o3', 'b1', 'f1']);
    assert.equal(d.calls.findMany, 3);
  });

  await check('a page inside one bucket reads just that one', async () => {
    const d = fakeDelegate(data);
    const { rows } = await pageAcrossBuckets(d, {
      buckets: buckets(['online', 'busy', 'offline']),
      skip: 5,
      take: 2,
    });
    assert.deepEqual(rows, ['f2', 'f3']);
    assert.equal(d.calls.findMany, 1);
  });

  await check('past the end is empty, with the true total', async () => {
    const { rows, total } = await pageAcrossBuckets(fakeDelegate(data), {
      buckets: buckets(['online', 'busy', 'offline']),
      skip: 40,
      take: 20,
    });
    assert.deepEqual(rows, []);
    assert.equal(total, all.length);
  });

  await check('empty buckets are skipped over', async () => {
    const { seen } = await walk(
      fakeDelegate({ pinned: [], rest: ['a', 'b', 'c'] }),
      ['pinned', 'rest'],
      2
    );
    assert.deepEqual(seen, ['a', 'b', 'c']);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
