'use strict';

const { JWT } = require('google-auth-library');

const env = require('../config/env');
const { errors } = require('../utils/errors');

/**
 * Collection, leg 1 — Google Play Billing.
 *
 * This module only talks to the Play Developer API (`androidpublisher`) — it
 * never touches a wallet balance. `wallet.service.js` owns what a verified
 * purchase *means* for a user's balance or VIP status; this is purely "is
 * this purchase token real, and for what product" plus "mark it consumed so
 * the user can buy it again."
 *
 * Every `RechargePackage`/`VipPlan` row's `id` doubles as the Google Play
 * Console product SKU — both are server-owned catalogue ids already, so
 * there is no separate mapping table to keep in sync.
 */

const SCOPES = ['https://www.googleapis.com/auth/androidpublisher'];
const API_BASE = 'https://androidpublisher.googleapis.com/androidpublisher/v3';

/** purchaseState values the Play Developer API returns. Only 0 means paid. */
const PURCHASE_STATE_PURCHASED = 0;

let client = null;

/** Built lazily so a server with no Play Billing credentials still boots. */
function instance() {
  if (!env.payments.googlePlay.configured) return null;
  if (!client) {
    client = new JWT({
      email: env.payments.googlePlay.serviceAccountEmail,
      key: env.payments.googlePlay.serviceAccountPrivateKey,
      scopes: SCOPES,
    });
  }
  return client;
}

async function authedFetch(path, { method = 'GET' } = {}) {
  const jwt = instance();
  if (!jwt) throw errors.paymentsUnavailable();

  let token;
  try {
    ({ token } = await jwt.getAccessToken());
  } catch (err) {
    // A malformed or revoked service-account key throws here, before any
    // HTTP request is even made — the same "never leak the raw provider
    // error" posture `paymentProviderError` already exists for.
    console.error('[play-billing] could not obtain an access token', err);
    throw errors.paymentProviderError();
  }

  const packageName = env.payments.googlePlay.packageName;
  const res = await fetch(`${API_BASE}/applications/${packageName}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, status: res.status, body };
  }
  // `consume` returns an empty body on success.
  const text = await res.text();
  return { ok: true, status: res.status, data: text ? JSON.parse(text) : {} };
}

/**
 * Verifies one purchase token against Google's own records.
 *
 * Never trusts what the client says the purchase was for — `productId` here
 * is what the *caller* believes it should be (the `RechargePackage`/`VipPlan`
 * id the client claims to have bought); the response's own product identity
 * is implicit in the URL Google looked it up under, and a token that does not
 * belong to that product simply will not resolve. Returns `null` for
 * anything that is not an unambiguous, paid purchase — a cancelled, pending,
 * or already-refunded purchase all resolve to "not verified" rather than
 * throwing, since none of those are a server error.
 */
async function verifyProductPurchase({ productId, purchaseToken }) {
  const result = await authedFetch(
    `/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`
  );

  if (!result.ok) {
    // A 404/410 means the token is unknown or expired — not a server
    // problem, just an unverifiable purchase. Anything else (a bad
    // credential, Google's own outage) is logged in full and surfaced as the
    // generic provider error, the same posture Razorpay's order creation used
    // to take with the raw SDK error.
    if (result.status === 400 || result.status === 404 || result.status === 410) {
      return null;
    }
    console.error('[play-billing] purchases.products.get failed', result.status, result.body);
    throw errors.paymentProviderError();
  }

  if (result.data.purchaseState !== PURCHASE_STATE_PURCHASED) return null;

  return {
    orderId: result.data.orderId ?? null,
    purchaseTimeMillis: result.data.purchaseTimeMillis ?? null,
    acknowledgementState: result.data.acknowledgementState ?? 0,
  };
}

/**
 * Consumes a one-time product so it becomes purchasable again.
 *
 * Every catalogue item here — a recharge package, a VIP term — is meant to
 * be bought repeatedly, so nothing is ever merely acknowledged and left
 * outstanding; consuming a product acknowledges it in the same call. Called
 * only after the wallet has already been credited: if this fails (a network
 * blip, Google's own outage), the money is already real and the ledger row
 * already exists, so failing loudly here would be a worse outcome than a
 * purchase that stays consumable-but-unconsumed until the next attempt —
 * logged, not thrown.
 */
async function consumeProductPurchase({ productId, purchaseToken }) {
  const result = await authedFetch(
    `/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:consume`,
    { method: 'POST' }
  );
  if (!result.ok) {
    console.error(
      '[play-billing] purchases.products.consume failed — wallet already credited',
      productId,
      result.status,
      result.body
    );
  }
}

module.exports = {
  verifyProductPurchase,
  consumeProductPurchase,
  get configured() {
    return env.payments.googlePlay.configured;
  },
};
