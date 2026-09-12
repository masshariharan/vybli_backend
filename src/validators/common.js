'use strict';

const { z } = require('zod');

/**
 * Pieces reused across schemas.
 *
 * Request bodies are **snake_case**, matching what the Flutter models emit
 * with `toJson()`. The mapping to camelCase happens once, in the service
 * layer, rather than being negotiated per endpoint.
 */

/** Digits only, 6–15, per E.164 minus the country code. */
const phone = z
  .string()
  .trim()
  .regex(/^\d{6,15}$/, 'Enter a valid phone number');

const dialCode = z
  .string()
  .trim()
  .regex(/^\+\d{1,4}$/, 'Enter a valid country code')
  .default('+91');

const otpCode = z
  .string()
  .trim()
  .regex(/^\d{4,8}$/, 'Enter the code you received');

const cuid = z.string().trim().min(1, 'Required');

const gender = z.enum(['male', 'female']);

const goal = z.enum(['makeFriends', 'earnMoney']);

const callType = z.enum(['voice', 'video']);

const discoveryScope = z.enum(['myCity', 'selectedCity', 'allCities']);

/** 18+ is a hard floor — the app states it and the backend must hold it. */
const age = z.coerce
  .number()
  .int()
  .min(18, 'You must be 18 or older to use Vybli')
  .max(80, 'Enter a valid age');

const name = z
  .string()
  .trim()
  .min(2, 'Your name needs at least 2 characters')
  .max(24, 'Keep your name under 24 characters');

const bio = z.string().trim().max(160, 'Keep your bio under 160 characters');

/**
 * The language codes a profile is stored with.
 *
 * Shape only. There is no catalogue on this server to check a code against any
 * more — it ships inside the app, which is the only party that renders a
 * language — so a code this build has never seen is a newer client's language,
 * not a fault. What is still worth refusing is junk: an unbounded string, or a
 * display name where a code belongs.
 *
 * Lowercased on the way in so `TA` and `ta` cannot become two rows on the same
 * profile, which the composite primary key would then reject outright.
 */
const languageCodes = z
  .array(
    z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z][a-z0-9-]{1,11}$/, 'That is not a language code')
  )
  .min(1, 'Pick at least one language')
  .max(20, 'That is more languages than we can match on');

/**
 * The same codes as a discovery *filter*, where empty is meaningful: it reads
 * as "any language" rather than as a profile that speaks none.
 */
const languageCodeFilter = z
  .array(
    z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z][a-z0-9-]{1,11}$/, 'That is not a language code')
  )
  .max(20, 'That is more languages than we can match on');

/**
 * Standard pagination.
 *
 * `limit` is capped at 100 in the schema, not merely defaulted — a client
 * asking for 10,000 rows should be corrected, not obeyed.
 */
const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** Turns page/limit into Prisma's skip/take. */
function toSkipTake({ page, limit }) {
  return { skip: (page - 1) * limit, take: limit };
}

module.exports = {
  z,
  phone,
  dialCode,
  otpCode,
  cuid,
  gender,
  goal,
  callType,
  discoveryScope,
  age,
  name,
  bio,
  languageCodes,
  languageCodeFilter,
  pagination,
  toSkipTake,
};
