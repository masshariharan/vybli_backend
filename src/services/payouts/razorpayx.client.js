'use strict';

/**
 * RazorpayX Payouts — the thin client.
 *
 * Only the four calls a UPI payout needs: a contact for the earner, a `vpa`
 * fund account for her UPI ID, the payout itself, and checking a webhook's
 * signature. Everything about *when* to call them, and what a result means
 * for her balance, lives in `payout.service`.
 *
 * Auth is HTTP Basic with the key id and secret. Nothing here ever reaches
 * the app. https://razorpay.com/docs/api/x/
 */

const crypto = require('node:crypto');
const env = require('../../config/env');

const API_BASE = 'https://api.razorpay.com/v1';

class RazorpayXError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message);
    this.name = 'RazorpayXError';
    this.status = status;
    this.code = code;
    this.body = body;
  }

  /// A 4xx means RazorpayX looked at the request and said no — retrying the
  /// same request will not help. Anything else (5xx, network) might.
  get isDefinite() {
    return this.status >= 400 && this.status < 500;
  }
}

async function api(path, { method = 'GET', body, idempotencyKey } = {}) {
  const { keyId, keySecret } = env.payouts.razorpayx;
  const headers = {
    Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
    'Content-Type': 'application/json',
  };
  if (idempotencyKey) headers['X-Payout-Idempotency'] = idempotencyKey;

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new RazorpayXError(`RazorpayX unreachable: ${err.message}`, { status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new RazorpayXError(data?.error?.description || `RazorpayX ${res.status}`, {
      status: res.status,
      code: data?.error?.code,
      body: data,
    });
  }
  return data;
}

/** The earner, as a RazorpayX contact. */
function createContact({ name, userId }) {
  return api('/contacts', {
    method: 'POST',
    body: {
      name: (name || 'Vybli earner').slice(0, 50),
      type: 'vendor',
      reference_id: userId,
    },
  });
}

/** Her UPI ID, as a fund account on that contact. */
function createUpiFundAccount({ contactId, upiId }) {
  return api('/fund_accounts', {
    method: 'POST',
    body: {
      contact_id: contactId,
      account_type: 'vpa',
      vpa: { address: upiId },
    },
  });
}

/**
 * Sends [amountInr] to the fund account over UPI.
 *
 * [withdrawalId] is both the idempotency key and the reference: a retried
 * request for the same withdrawal returns the payout already made instead of
 * paying twice. Queued, not refused, when the RazorpayX balance is low — it
 * goes out as soon as the account is topped up.
 */
function createPayout({ fundAccountId, amountInr, withdrawalId }) {
  return api('/payouts', {
    method: 'POST',
    idempotencyKey: withdrawalId,
    body: {
      account_number: env.payouts.razorpayx.accountNumber,
      fund_account_id: fundAccountId,
      amount: Math.round(Number(amountInr) * 100),
      currency: 'INR',
      mode: 'UPI',
      purpose: 'payout',
      queue_if_low_balance: true,
      reference_id: withdrawalId,
      narration: 'Vybli earnings',
    },
  });
}

/** A payout's current state, for a reconcile or a retry. */
function fetchPayout(payoutId) {
  return api(`/payouts/${encodeURIComponent(payoutId)}`);
}

/**
 * Whether [rawBody] was really signed by RazorpayX: an HMAC-SHA256 of the
 * exact bytes received, with the webhook secret, compared in constant time.
 */
function verifyWebhookSignature(rawBody, signature, secret = env.payouts.razorpayx.webhookSecret) {
  if (!rawBody || !signature || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  RazorpayXError,
  createContact,
  createUpiFundAccount,
  createPayout,
  fetchPayout,
  verifyWebhookSignature,
};
