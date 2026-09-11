'use strict';

const env = require('../config/env');
const { AppError } = require('../utils/errors');

/** Anything that reaches here has no route. */
function notFoundHandler(req, _res, next) {
  next(
    new AppError(`No route for ${req.method} ${req.originalUrl}`, {
      status: 404,
      code: 'ROUTE_NOT_FOUND',
    })
  );
}

/**
 * The single place an error becomes a response.
 *
 * Two rules:
 *
 *  * Only errors we raised on purpose keep their message. Anything else — a
 *    driver failure, a typo — becomes a generic 500, because raw messages leak
 *    table names, file paths and query fragments to whoever is probing.
 *  * Unexpected errors are logged with their stack. Expected ones are not:
 *    "wrong OTP" is normal traffic, and burying real faults under thousands of
 *    those is how an outage goes unnoticed.
 */
// The unused fourth argument is not optional: Express identifies an error
// handler by its arity, and a three-argument function is silently treated as
// ordinary middleware and never called.
function errorHandler(err, req, res, _next) {
  let status = err.status || err.statusCode || 500;
  let code = err.code || 'INTERNAL_ERROR';
  let message = err.message || 'Something went wrong';
  let details = err.details;

  const deliberate = err instanceof AppError || err.expose === true;

  // Prisma's known failures map onto meanings a client can act on.
  //
  // Matched as `P` followed by digits, and only on errors we did not raise
  // ourselves. A looser `startsWith('P')` also catches PAYMENT_FAILED,
  // PACKAGE_NOT_FOUND and PROFILE_NOT_FOUND — deliberate domain codes that
  // were being rewritten into generic 500s.
  const isPrismaCode = !deliberate && /^P\d{4}$/.test(String(err.code ?? ''));

  if (isPrismaCode) {
    if (err.code === 'P2002') {
      status = 409;
      code = 'CONFLICT';
      message = 'That already exists.';
      details = { fields: err.meta?.target };
    } else if (err.code === 'P2025') {
      status = 404;
      code = 'NOT_FOUND';
      message = 'That record no longer exists.';
      details = undefined;
    } else {
      status = 500;
      code = 'DATABASE_ERROR';
      message = 'Something went wrong on our end';
      details = undefined;
    }
  }
  if (!deliberate && status >= 500) {
    message = 'Something went wrong on our end';
    details = undefined;
  }

  if (status >= 500) {
    console.error(
      `[error] ${req.method} ${req.originalUrl} → ${status} ${code}`,
      err.stack || err
    );
  }

  const body = { success: false, message, error: code };
  if (details !== undefined) body.details = details;
  // The stack is a development aid, never shipped.
  if (!env.isProduction && status >= 500) body.stack = err.stack;

  res.status(status).json(body);
}

/**
 * Wraps an async handler so a rejected promise reaches [errorHandler].
 *
 * Without this an `await` that throws inside a route hangs the request until
 * it times out, because Express 4 does not catch promise rejections.
 */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { notFoundHandler, errorHandler, asyncHandler };
