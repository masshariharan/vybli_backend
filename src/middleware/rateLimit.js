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
  keyGenerator: (req) => `${req.body?.dial_code ?? ''}${req.body?.phone ?? req.ip}`,
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
  keyGenerator: (req) => `${req.body?.dial_code ?? ''}${req.body?.phone ?? req.ip}`,
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
  paymentLimiter,
};
