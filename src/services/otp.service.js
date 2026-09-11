'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const prisma = require('../config/prisma');
const env = require('../config/env');
const { errors } = require('../utils/errors');
const smsService = require('./sms.service');

/**
 * Phone verification.
 *
 * Three properties matter and each costs something:
 *
 *  * Codes are **hashed** at rest. An OTP is a password for five minutes, and
 *    a leaked table must not hand over live sessions.
 *  * Each code carries its **own attempt counter**, so five wrong guesses burn
 *    that code rather than merely slowing the request rate.
 *  * Requesting a new code **invalidates the previous one**. Two live codes for
 *    one number doubles an attacker's odds for no user benefit.
 *
 * Delivery is [sms.service]'s job. `OTP_DEV_MODE` with no provider configured
 * prints the code instead of sending it, so the app is testable end to end
 * without an SMS account; production refuses to boot in that state.
 */

function generateCode(length) {
  // crypto, not Math.random — an OTP generated from a predictable PRNG is not
  // a secret.
  const max = 10 ** length;
  const value = crypto.randomInt(0, max);
  return String(value).padStart(length, '0');
}

/**
 * Hands the code to the user. Replace the body with an SMS provider call.
 *
 * Deliberately never returns the code — the caller decides whether to expose
 * it, and only in development.
 */
async function deliver({ dialCode, phone, code }) {
  // Development with no provider: print it and carry on, so the app is
  // testable end to end without an SMS account. `env` refuses to boot in
  // production with `devMode` on.
  if (env.otp.devMode && !env.sms.configured) {
    console.info(`[otp] ${dialCode}${phone} → ${code} (dev mode, not sent by SMS)`);
    return;
  }

  await smsService.sendOtp({ dialCode, phone, code });
}

/**
 * Issues a code for a number.
 *
 * @returns {{ expiresAt: Date, devCode?: string }}
 */
async function requestOtp({ dialCode, phone, purpose = 'login' }) {
  const now = new Date();

  // Cooldown, checked against the most recent code rather than a counter, so
  // it survives a restart.
  const latest = await prisma.otpCode.findFirst({
    where: { dialCode, phone, purpose },
    orderBy: { createdAt: 'desc' },
  });

  if (latest) {
    const elapsedSeconds = (now - latest.createdAt) / 1000;
    if (elapsedSeconds < env.otp.resendCooldownSeconds) {
      throw errors.otpCooldown(
        Math.ceil(env.otp.resendCooldownSeconds - elapsedSeconds)
      );
    }
  }

  const code = generateCode(env.otp.length);
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(now.getTime() + env.otp.expirySeconds * 1000);

  await prisma.$transaction([
    // Retire outstanding codes first — exactly one live code per number.
    prisma.otpCode.updateMany({
      where: { dialCode, phone, purpose, consumedAt: null },
      data: { consumedAt: now },
    }),
    prisma.otpCode.create({
      data: { dialCode, phone, codeHash, purpose, expiresAt },
    }),
  ]);

  await deliver({ dialCode, phone, code });

  return {
    expiresAt,
    // Development only. `env` refuses to start in production with this on.
    devCode: env.otp.devMode ? code : undefined,
  };
}

/**
 * Checks a code and consumes it.
 *
 * Consuming on success is what stops the same code being replayed to mint a
 * second session.
 */
async function verifyOtp({ dialCode, phone, code, purpose = 'login' }) {
  const record = await prisma.otpCode.findFirst({
    where: { dialCode, phone, purpose, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });

  if (!record) throw errors.otpInvalid();

  if (record.expiresAt < new Date()) {
    await prisma.otpCode.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    });
    throw errors.otpExpired();
  }

  if (record.attempts >= env.otp.maxAttempts) {
    await prisma.otpCode.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    });
    throw errors.otpTooManyAttempts();
  }

  const matches = await bcrypt.compare(code, record.codeHash);

  if (!matches) {
    const updated = await prisma.otpCode.update({
      where: { id: record.id },
      data: { attempts: { increment: 1 } },
    });
    // Burn the code on the last allowed miss rather than leaving it alive for
    // the limiter to catch on the next request.
    if (updated.attempts >= env.otp.maxAttempts) {
      await prisma.otpCode.update({
        where: { id: record.id },
        data: { consumedAt: new Date() },
      });
      throw errors.otpTooManyAttempts();
    }
    throw errors.otpInvalid();
  }

  await prisma.otpCode.update({
    where: { id: record.id },
    data: { consumedAt: new Date() },
  });

  return true;
}

/** Housekeeping for a cron: drop codes that can no longer be used. */
async function purgeExpired(olderThanHours = 24) {
  const cutoff = new Date(Date.now() - olderThanHours * 3600_000);
  const { count } = await prisma.otpCode.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  return count;
}

module.exports = { requestOtp, verifyOtp, purgeExpired, generateCode };
