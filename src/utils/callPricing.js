'use strict';

/**
 * What a call costs per minute — the one place that says so.
 *
 * `call.service.startUnlocked` snapshots this onto the call row, and every
 * minute is billed at that snapshot; `discovery.controller.randomMatch` quotes
 * it before the call is placed. Both go through here so the quote and the
 * charge cannot drift apart.
 */

/**
 * The flat price, in rupees per minute — now only a fallback for a call whose
 * genders are unknown. Every real call is priced by a level: see [listRate].
 */
const BASE_RATE = { voice: 5, video: 20 };

/** Required lazily: the service needs the database; this file is a util. */
const pricing = () => require('../services/pricing.service');

/**
 * The price per minute of a [type] call between these two profiles, before
 * any discount:
 *
 *   two women        free
 *   a man, a woman   her level's price on the women's ladder
 *   two men          the answering man's level price on the men's ladder
 *
 * One function for the quote on a card, the random-match quote and the
 * rate a call is billed at, so the three cannot disagree.
 */
function listRate(type, { callerProfile, calleeProfile } = {}) {
  const callerGender = callerProfile?.gender;
  const calleeGender = calleeProfile?.gender;
  if (callerGender === 'female' && calleeGender === 'female') return 0;
  if (callerGender && calleeGender && callerGender !== calleeGender) {
    const woman = callerGender === 'female' ? callerProfile : calleeProfile;
    return pricing().rateFor(woman, type);
  }
  if (callerGender === 'male' && calleeGender === 'male') {
    return pricing().rateFor(calleeProfile, type);
  }
  return BASE_RATE[type] ?? BASE_RATE.video;
}

/**
 * Whose ladder prices a call between these two — and whose statistics it
 * counts towards: `{ audience, holder }`, where `holder` is `'caller'` or
 * `'callee'`. Null for a free call between two women.
 */
function pricedBy({ callerGender, calleeGender } = {}) {
  if (callerGender === 'female' && calleeGender === 'female') return null;
  if (callerGender === 'female' && calleeGender === 'male') {
    return { audience: 'female', holder: 'caller' };
  }
  if (callerGender === 'male' && calleeGender === 'female') {
    return { audience: 'female', holder: 'callee' };
  }
  if (callerGender === 'male' && calleeGender === 'male') {
    return { audience: 'male', holder: 'callee' };
  }
  return null;
}

/**
 * What the payer is charged per minute: [listRate] less their VIP discount.
 *
 * @param {'voice'|'video'} type
 * @param {object} opts
 * @param {object} [opts.callerProfile] `{ gender, voiceLevel, videoLevel }`
 * @param {object} [opts.calleeProfile]
 * @param {number} [opts.discountPct] the payer's VIP call discount, 0–100
 */
function ratePerMinute(type, { callerProfile, calleeProfile, discountPct = 0 } = {}) {
  const base = listRate(type, { callerProfile, calleeProfile });
  if (!(base > 0)) return 0;
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
 * Decided by [payerSide] and [listRate] with the viewer as caller, so the
 * price on a card is the one `call.service` will actually charge — her level
 * price for a man looking at a woman, his for a man looking at a man.
 *
 * `null` when either gender is unknown, so the caller can fall back.
 */
function quotedRate(type, { viewerProfile, peerProfile } = {}) {
  const viewerGender = viewerProfile?.gender;
  const peerGender = peerProfile?.gender;
  if (!viewerGender || !peerGender) return null;
  const genders = { callerGender: viewerGender, calleeGender: peerGender };
  return payerSide(genders) === 'caller'
    ? listRate(type, { callerProfile: viewerProfile, calleeProfile: peerProfile })
    : 0;
}

module.exports = { BASE_RATE, listRate, pricedBy, ratePerMinute, payerSide, quotedRate };
