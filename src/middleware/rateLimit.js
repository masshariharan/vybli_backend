'use strict';

const rateLimit = require('express-rate-limit');
const env = require('../config/env');

/**
 * Rate limits, tightest where abuse is cheapest.
 *
 * Sending an OTP costs money and can be used to spam a stranger's phone, so it
 * is limited per *number* rather than per IP — one attacker behind one address
 * hitting a hundred different numbers is the case an IP limit misses entirely.
 */

/**
 * The number an OTP request is about, the same however it was typed.
 *
 * Keyed on the raw body, `"9876543210"`, `" 9876543210"` and `"+91 98765
 * 43210"` were three different limits for one phone — so the per-number cap
 * was only ever as tight as an attacker's patience with whitespace. Digits
 * only, the last ten of them (the national number, for India), under the
 * dial code's digits.
 */
function phoneKey(req) {
  const digits = String(req.body?.phone ?? '').replace(/\D/g, '');
  if (!digits) return `ip:${req.ip}`;
  const dial = String(req.body?.dial_code ?? '+91').replace(/\D/g, '') || '91';
  return `${dial}:${digits.slice(-10)}`;
}

const jsonLimit = (message, code) => (_req, res) =>
  res.status(429).json({ success: false, message, error: code });

/** Baseline for everything. Generous — this is a backstop, not a policy. */
const globalLimiter = rateLimit({
  windowMs: env.rateLimit.windowMs,
  max: env.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonLimit('Too many requests. Please slow down.', 'RATE_LIMITED'),
});

/** Requesting an OTP: keyed on the phone number being texted. */
const otpRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: phoneKey,
  handler: jsonLimit(
    'Too many codes requested for this number. Try again in a few minutes.',
    'OTP_RATE_LIMITED'
  ),
});

/**
 * Verifying an OTP: stops someone brute-forcing six digits.
 *
 * The per-code attempt counter in the database is the real guard; this stops
 * an attacker sidestepping it by requesting a fresh code after every fifth
 * guess.
 */
const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: phoneKey,
  handler: jsonLimit(
    'Too many verification attempts. Please wait a few minutes.',
    'OTP_RATE_LIMITED'
  ),
});

/** Writes that create rows other people see: messages, requests, reports. */
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId ?? req.ip,
  handler: jsonLimit('You are doing that too quickly.', 'RATE_LIMITED'),
});

/**
 * Help & Support messages. Each one lands in a person's inbox in the admin
 * panel, so a handful per user is plenty — enough to follow up on a message,
 * not enough to flood the queue.
 */
const supportLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId ?? req.ip,
  handler: jsonLimit(
    'You have sent several messages already. Please wait a few minutes.',
    'RATE_LIMITED'
  ),
});

/** Anything that moves money. */
const paymentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId ?? req.ip,
  handler: jsonLimit('Too many payment attempts. Please wait a moment.', 'RATE_LIMITED'),
});

module.exports = {
  globalLimiter,
  otpRequestLimiter,
  otpVerifyLimiter,
  writeLimiter,
  supportLimiter,
  paymentLimiter,
};
