'use strict';

/**
 * SMS cost arithmetic and billing-day boundaries. Pure — no server needed.
 *
 *   npm run test:sms-pricing
 */

const assert = require('assert');
const P = require('../src/utils/smsPricing');

const INDIA = { rateUsd: 0.07, usdToInr: 90, freePerDay: 10, pricedRegion: 'IN' };
let passed = 0;
function test(label, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${label}`);
}

console.log('\nSMS pricing\n');

test('100 SMS in a day: 10 free, 90 paid, $6.30, ₹567', () => {
  const r = P.priceDay({ sent: 100, regions: { IN: { sent: 100 } } }, INDIA);
  assert.deepStrictEqual(r, { freeSms: 10, paidSms: 90, unpricedSms: 0, estCostUsd: 6.3, estCostInr: 567 });
});

test('30 such days come to ₹17,010', () => {
  const day = P.priceDay({ sent: 100, regions: { IN: { sent: 100 } } }, INDIA);
  assert.strictEqual(P.round4(day.estCostInr * 30), 17010);
});

test('the free ten are per day, not per user: 7 SMS cost nothing', () => {
  const r = P.priceDay({ sent: 7, regions: { IN: { sent: 7 } } }, INDIA);
  assert.deepStrictEqual([r.freeSms, r.paidSms, r.estCostInr], [7, 0, 0]);
});

test('exactly 10 is free, 11 costs one SMS', () => {
  assert.strictEqual(P.priceDay({ sent: 10, regions: {} }, INDIA).estCostUsd, 0);
  assert.strictEqual(P.priceDay({ sent: 11, regions: {} }, INDIA).estCostUsd, 0.07);
});

test('no float drift: 3 paid SMS is exactly $0.21 / ₹18.90', () => {
  const r = P.priceDay({ sent: 13, regions: {} }, INDIA);
  assert.strictEqual(r.estCostUsd, 0.21);
  assert.strictEqual(r.estCostInr, 18.9);
});

test('SMS to other regions are counted but left unpriced', () => {
  const r = P.priceDay({ sent: 25, regions: { IN: { sent: 20 }, US: { sent: 5 } } }, INDIA);
  assert.deepStrictEqual([r.freeSms, r.paidSms, r.unpricedSms, r.estCostUsd], [10, 15, 5, 0.7]);
});

test('zero usage costs zero', () => {
  assert.deepStrictEqual(P.priceDay({ sent: 0, regions: {} }, INDIA), {
    freeSms: 0, paidSms: 0, unpricedSms: 0, estCostUsd: 0, estCostInr: 0,
  });
});

console.log('\nBilling days\n');

const LA = 'America/Los_Angeles';

test('a Pacific billing day starts at 07:00 UTC in summer, 08:00 in winter', () => {
  assert.strictEqual(P.startOfDay('2026-10-08', LA).toISOString(), '2026-10-08T07:00:00.000Z');
  assert.strictEqual(P.startOfDay('2026-12-01', LA).toISOString(), '2026-12-01T08:00:00.000Z');
});

test('DST change day (2026-11-01) starts at the right instant', () => {
  assert.strictEqual(P.startOfDay('2026-11-01', LA).toISOString(), '2026-11-01T07:00:00.000Z');
  assert.strictEqual(P.startOfDay('2026-11-02', LA).toISOString(), '2026-11-02T08:00:00.000Z');
});

test('dayOf: 06:59 UTC is still the previous Pacific day', () => {
  assert.strictEqual(P.dayOf(new Date('2026-10-08T06:59:59Z'), LA), '2026-10-07');
  assert.strictEqual(P.dayOf(new Date('2026-10-08T07:00:00Z'), LA), '2026-10-08');
});

test('IST days work too (half-hour offset)', () => {
  assert.strictEqual(P.startOfDay('2026-10-08', 'Asia/Kolkata').toISOString(), '2026-10-07T18:30:00.000Z');
});

test('calendar arithmetic across month and year ends', () => {
  assert.strictEqual(P.addDays('2026-10-31', 1), '2026-11-01');
  assert.strictEqual(P.addDays('2027-01-01', -1), '2026-12-31');
  assert.strictEqual(P.daysBetween('2026-02-27', '2026-03-01').length, 3);
  assert.strictEqual(P.daysInMonth('2028-02-10'), 29);
});

console.log(`\n${passed} passed\n`);
