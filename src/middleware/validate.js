'use strict';

const { ZodError } = require('zod');
const { errors } = require('../utils/errors');

/**
 * Schema validation for request input.
 *
 * Validated values **replace** the raw ones, so a controller downstream can
 * never accidentally read an unparsed string where the schema promised a
 * number, and unknown keys are dropped rather than carried into a Prisma call.
 *
 * Usage: `router.post('/x', validate({ body: schema }), controller)`
 */
function validate(schemas = {}) {
  return (req, _res, next) => {
    try {
      for (const key of ['body', 'query', 'params']) {
        const schema = schemas[key];
        if (!schema) continue;
        const parsed = schema.parse(req[key] ?? {});
        // Express 5 makes req.query a getter, so assigning to it throws.
        // Stashing the parsed values is safe on every version.
        if (key === 'query') req.validatedQuery = parsed;
        else req[key] = parsed;
      }
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        // Flattened into { field: message } — a client can drop these straight
        // onto the matching inputs instead of parsing Zod's issue tree.
        const details = {};
        for (const issue of err.errors) {
          const path = issue.path.join('.') || '_';
          if (!details[path]) details[path] = issue.message;
        }
        return next(errors.validation(details));
      }
      next(err);
    }
  };
}

/** Reads validated query params, falling back to the raw ones. */
function q(req) {
  return req.validatedQuery ?? req.query ?? {};
}

module.exports = { validate, q };
