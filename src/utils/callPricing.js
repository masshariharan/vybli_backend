'use strict';

/**
 * What a call costs per minute — the one place that says so.
 *
 * `call.service.startUnlocked` snapshots this onto the call row, and every
 * minute is billed at that snapshot; `discovery.controller.randomMatch` quotes
 * it before the call is placed. Both go through here so the quote and the
 * charge cannot drift apart.
 */

/** List prices, in rupees per minute. */
const BASE_RATE = { voice: 5, video: 20 };

/**
 * @param {'voice'|'video'} type
 * @param {object} opts
 * @param {string} [opts.callerGender]
 * @param {string} [opts.calleeGender]
 * @param {number} [opts.discountPct] the payer's VIP call discount, 0–100
 */
function ratePerMinute(type, { callerGender, calleeGender, discountPct = 0 } = {}) {
  // Female-to-female calls are free — no payer, nothing to discount.
  if (callerGender === 'female' && calleeGender === 'female') return 0;
  const base = BASE_RATE[type] ?? BASE_RATE.video;
  const pct = Math.min(Math.max(discountPct, 0), 100);
  // Rounded to the paisa: the rate is stored as Decimal(10, 2), and billing
  // debits exactly the stored figure each minute.
  return Math.round(base * (100 - pct)) / 100;
}

module.exports = { BASE_RATE, ratePerMinute };
