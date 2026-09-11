'use strict';

const env = require('../config/env');
const { errors } = require('../utils/errors');

/**
 * Sending an SMS.
 *
 * One provider today, behind one function, because the seam is what matters:
 * everything upstream — the OTP service, the account-deletion code — asks for
 * "deliver this text to this number" and knows nothing about who carries it.
 * Swapping MSG91 for Twilio is this file and nothing else.
 *
 * Two things about MSG91 in particular shape the code below:
 *
 *  * **It answers HTTP 200 on failure.** A rejected template, a blocked
 *    number, an exhausted balance — all come back 200 with `type: "error"` in
 *    the body. Trusting the status code would mean silently not sending
 *    codes, which looks to the user like a broken app.
 *  * **The message text lives on their side**, in a DLT-registered template.
 *    We send the template id and the variables, never the sentence. Indian
 *    carriers reject anything whose text does not match the registration
 *    character for character.
 */

const MSG91_ENDPOINT = 'https://control.msg91.com/api/v5/flow/';

/** Long enough for a slow carrier hop, short enough not to hang a sign-in. */
const TIMEOUT_MS = 10_000;

/**
 * `+91` + `9876543210` → `919876543210`.
 *
 * MSG91 wants country code and number with no plus and no separators. Sending
 * the `+` is the single most common reason a request is accepted and nothing
 * arrives.
 */
function toMsg91Number(dialCode, phone) {
  const digits = `${dialCode}${phone}`.replace(/\D/g, '');
  if (digits.length < 10) {
    throw errors.badRequest('That phone number does not look complete.');
  }
  return digits;
}

/**
 * Sends the OTP through MSG91.
 *
 * Retries once, and only on a *transport* failure — a timeout or a 5xx. A
 * rejected template or a bad number will fail identically the second time, so
 * retrying those would just double the latency before the user sees an error.
 */
async function sendViaMsg91({ dialCode, phone, code }) {
  const body = {
    template_id: env.sms.msg91.templateId,
    short_url: '0',
    // Ask MSG91 to report the outcome in this response rather than only on a
    // webhook. Without it a failure is invisible until someone reads a report.
    realTimeResponse: '1',
    recipients: [
      {
        mobiles: toMsg91Number(dialCode, phone),
        [env.sms.msg91.otpVariable]: code,
      },
    ],
  };

  // Optional: most accounts carry the sender on the template itself.
  if (env.sms.msg91.senderId) body.sender = env.sms.msg91.senderId;

  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let response;
    try {
      response = await fetch(MSG91_ENDPOINT, {
        method: 'POST',
        headers: {
          authkey: env.sms.msg91.authKey,
          'Content-Type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // Timeout or a dead socket. Worth one more try.
      lastError = err.name === 'TimeoutError' ? 'timed out' : err.message;
      if (attempt === 1) continue;
      break;
    }

    const payload = await response.json().catch(() => null);

    if (response.status >= 500) {
      lastError = `MSG91 returned ${response.status}`;
      if (attempt === 1) continue;
      break;
    }

    // The important check. `type` is the truth, not the status code.
    if (response.ok && payload?.type === 'success') {
      // The request id is what MSG91 support asks for when a message did not
      // arrive. The code itself is never logged.
      console.info(`[sms] sent to ${dialCode}${maskPhone(phone)} — ref ${payload.message}`);
      return { reference: payload.message };
    }

    // A definite rejection: template not approved, sender not registered,
    // number on DND, balance exhausted. Retrying changes none of those.
    lastError = payload?.message || `MSG91 rejected the request (${response.status})`;
    break;
  }

  console.error(`[sms] could not send to ${dialCode}${maskPhone(phone)} — ${lastError}`);
  throw errors.smsDeliveryFailed();
}

/** `9876543210` → `98****3210`, so a log can be read without exposing numbers. */
function maskPhone(phone) {
  const s = String(phone);
  if (s.length < 6) return '****';
  return `${s.slice(0, 2)}****${s.slice(-4)}`;
}

/**
 * The one entry point.
 *
 * Throws if no provider is configured, rather than returning quietly: a code
 * that was never sent must not look to the caller like a code that was.
 */
async function sendOtp({ dialCode, phone, code }) {
  if (!env.sms.configured) {
    throw errors.internal('SMS delivery is not configured on this server.');
  }

  switch (env.sms.provider) {
    case 'msg91':
      return sendViaMsg91({ dialCode, phone, code });
    default:
      throw errors.internal(`Unknown SMS provider "${env.sms.provider}".`);
  }
}

module.exports = { sendOtp, toMsg91Number, maskPhone };
