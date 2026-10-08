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

/**
 * Which side of a call pays: 'caller', 'callee', or null for a free call.
 *
 * Women on Vybli are earners only — they never pay, whoever dialled. So in a
 * call between a man and a woman **the man pays**, whether he placed it or
 * she did; she is the one who earns. Two men: the caller pays, as before.
 * Two women: free.
 *
 * This used to be "the caller pays" for every billed call, which charged a
 * woman for calling a man and stopped her at "You do not have enough balance
 * for this call · Add money" — an action no earner account should ever see.
 *
 * A gender this does not recognise falls back to the caller, as it always
 * did.
 */
function payerSide({ callerGender, calleeGender } = {}) {
  if (callerGender === 'female' && calleeGender === 'female') return null;
  if (callerGender === 'female' && calleeGender === 'male') return 'callee';
  return 'caller';
}

/**
 * The list price a viewer is quoted for calling `peer` — what they would pay
 * per minute, before their VIP discount (the client applies that from its
 * own wallet). 0 when the viewer would not pay: a woman never does, and two
 * women call free.
 *
 * Decided by [payerSide] with the viewer as caller, so the price on a card
 * is the one `call.service` will actually charge. It used to be decided by
 * whether the peer was an earner, which hid the price on a man's card from
 * another man — who is charged ₹5/min for that call all the same.
 *
 * `null` when either gender is unknown, so the caller can fall back.
 */
function quotedRate(type, { viewerGender, peerGender } = {}) {
  if (!viewerGender || !peerGender) return null;
  const genders = { callerGender: viewerGender, calleeGender: peerGender };
  return payerSide(genders) === 'caller' ? BASE_RATE[type] ?? BASE_RATE.video : 0;
}

module.exports = { BASE_RATE, ratePerMinute, payerSide, quotedRate };
