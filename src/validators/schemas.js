'use strict';

const {
  z,
  phone,
  dialCode,
  otpCode,
  cuid,
  gender,
  callType,
  discoveryScope,
  age,
  name,
  bio,
  languageCodes,
  pagination,
} = require('./common');

/**
 * Every request schema, grouped by the flow it belongs to.
 *
 * One file rather than a dozen: the schemas are small, they cross-reference
 * each other, and having the whole input surface of the API readable in one
 * place is worth more than the separation would be.
 */

// ── Auth ────────────────────────────────────────────────────────────────────

const auth = {
  requestOtp: z.object({
    dial_code: dialCode,
    phone,
  }),

  verifyOtp: z.object({
    dial_code: dialCode,
    phone,
    code: otpCode,
    device: z.string().trim().max(120).optional(),
  }),

  /** A Firebase ID token, exchanged for a Vybli session. */
  firebaseSignIn: z.object({
    id_token: z.string().min(20, 'Missing Firebase token'),
    device: z.string().max(120).optional(),
  }),

  refresh: z.object({
    refresh_token: z.string().trim().min(10, 'Missing refresh token'),
  }),

  logout: z.object({
    // Absent means "this device only, using the access token's session".
    refresh_token: z.string().trim().optional(),
    all_devices: z.boolean().default(false),
  }),

  deleteAccount: z.object({
    // No confirmation code. The client confirms in its own UI — a consent
    // checkbox and a destructive dialog — and a valid access token is taken as
    // sufficient authority. This is a deliberate product choice: re-confirming
    // by SMS cost a message per attempt and a step per user, and the account it
    // protects is behind a phone lock either way.
    reason: z.string().trim().max(300).optional(),
  }),
};

// ── Onboarding ──────────────────────────────────────────────────────────────

const onboarding = {
  gender: z.object({ gender }),
  age: z.object({ age }),
  languages: z.object({ language_codes: languageCodes }),
  location: z.object({ city_id: z.string().trim().min(1, 'Pick your city') }),
  profile: z.object({
    name,
    bio: bio.optional(),
  }),
};

// ── Profile & settings ──────────────────────────────────────────────────────

const profile = {
  // No `gender` — it decides caller/earner status (see
  // `onboarding.service.setGender`), so letting it change here would let an
  // account switch roles — skip earner verification, or drop out of it —
  // without going through either flow. Once set at `/onboarding/gender` it
  // is fixed for the life of the account.
  update: z
    .object({
      name: name.optional(),
      age: age.optional(),
      bio: bio.optional(),
      city_id: z.string().trim().min(1).optional(),
      language_codes: languageCodes.optional(),
    })
    .refine((data) => Object.keys(data).length > 0, {
      message: 'Nothing to update',
    }),

  presence: z.object({
    status: z.enum(['online', 'offline', 'busy']),
  }),
};

const settings = {
  privacy: z
    .object({
      profile_visible_to_everyone: z.boolean().optional(),
      show_online_status: z.boolean().optional(),
      show_city_on_profile: z.boolean().optional(),
      allow_voice_calls: z.boolean().optional(),
      allow_video_calls: z.boolean().optional(),
      allow_messages: z.boolean().optional(),
    })
    .refine((d) => Object.keys(d).length > 0, { message: 'Nothing to update' }),

  notifications: z
    .object({
      incoming_calls: z.boolean().optional(),
      missed_calls: z.boolean().optional(),
      messages: z.boolean().optional(),
      new_matches: z.boolean().optional(),
      earnings: z.boolean().optional(),
      promotions: z.boolean().optional(),
    })
    .refine((d) => Object.keys(d).length > 0, { message: 'Nothing to update' }),

  discovery: z
    .object({
      min_age: z.coerce.number().int().min(18).max(80).optional(),
      max_age: z.coerce.number().int().min(18).max(80).optional(),
      languages: z.array(z.string().trim()).optional(),
      voice_calls: z.boolean().optional(),
      video_calls: z.boolean().optional(),
    })
    .refine((d) => Object.keys(d).length > 0, { message: 'Nothing to update' })
    .refine((d) => !(d.min_age && d.max_age) || d.min_age <= d.max_age, {
      message: 'The minimum age cannot be above the maximum',
      path: ['min_age'],
    }),
};

// ── Languages & cities ──────────────────────────────────────────────────────

const reference = {
  languageQuery: z.object({
    q: z.string().trim().max(60).optional(),
    popular_only: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
  }),

  /// A coordinate to resolve. Coerced because it arrives as a query string.
  ///
  /// Both optional: omitting them asks the server to work it out from the
  /// caller's IP instead, which is the path for a phone that cannot produce a
  /// fix. Supplying one without the other is refused rather than half-honoured.
  nearestQuery: z
    .object({
      lat: z.coerce.number().min(-90).max(90).optional(),
      lng: z.coerce.number().min(-180).max(180).optional(),
    })
    .refine((v) => (v.lat === undefined) === (v.lng === undefined), {
      message: 'Send both lat and lng, or neither.',
    }),

  /// Optional on the city list: supplying a coordinate ranks the result by
  /// distance instead of by popularity.
  cityQuery: z.object({
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    q: z.string().trim().max(60).optional(),
    popular_only: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    // Discovery's own city filter asks for this — only cities with a real
    // account already in them, as opposed to onboarding's "where do you
    // live" picker, which omits it and gets every city.
    has_users: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
  }),

  setLanguages: z.object({ language_codes: languageCodes }),
  languageParam: z.object({ code: z.string().trim().min(1) }),
};

// ── Discovery ───────────────────────────────────────────────────────────────

const discovery = {
  feed: pagination.extend({
    scope: discoveryScope.default('myCity'),
    // Required when scope is selectedCity; checked below.
    city_id: z.string().trim().optional(),
    q: z.string().trim().max(60).optional(),
    // Overrides for the saved discovery settings, for one-off filtering.
    min_age: z.coerce.number().int().min(18).max(80).optional(),
    max_age: z.coerce.number().int().min(18).max(80).optional(),
    languages: z
      .string()
      .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean))
      .optional(),
    online_only: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
  }).refine((d) => d.scope !== 'selectedCity' || Boolean(d.city_id), {
    message: 'Choose a city',
    path: ['city_id'],
  }),

  randomMatch: z.object({
    scope: discoveryScope.default('myCity'),
    city_id: z.string().trim().optional(),
    type: callType,
    // Ids already offered and skipped, so "Skip" does not re-suggest them.
    exclude_ids: z.array(cuid).max(50).default([]),
  }),
};

// ── Friend requests ─────────────────────────────────────────────────────────

const friends = {
  send: z.object({
    user_id: cuid,
    message: z.string().trim().max(300).optional(),
  }),
  requestParam: z.object({ id: cuid }),
  userParam: z.object({ id: cuid }),
  list: pagination.extend({
    direction: z.enum(['incoming', 'outgoing', 'all']).default('all'),
    status: z.enum(['pending', 'accepted', 'rejected', 'cancelled']).optional(),
  }),
};

// ── Messaging ───────────────────────────────────────────────────────────────

const chat = {
  conversationParam: z.object({ id: cuid }),

  list: pagination.extend({
    // The app's Chats screen has two tabs backed by these.
    filter: z.enum(['accepted', 'requests', 'all']).default('accepted'),
  }),

  history: pagination.extend({
    // Cursor paging for a thread: messages arrive while you scroll, and
    // offsets shift under you.
    before: z.string().trim().optional(),
  }),

  send: z
    .object({
      text: z.string().max(4000).default(''),
      attachment: z
        .object({
          kind: z.enum(['image', 'video', 'document', 'audio', 'location', 'contact']),
          title: z.string().trim().max(200),
          subtitle: z.string().trim().max(200).optional(),
          image_url: z.string().trim().max(2000).optional(),
          duration_label: z.string().trim().max(20).optional(),
        })
        .optional(),
      // Lets the client reconcile its optimistic bubble with the saved row.
      client_id: z.string().trim().max(64).optional(),
    })
    .refine((d) => d.text.trim().length > 0 || d.attachment, {
      message: 'Write a message or attach something',
      path: ['text'],
    }),

  mute: z.object({ muted: z.boolean() }),
};

// ── Calls ───────────────────────────────────────────────────────────────────

const calls = {
  start: z.object({
    user_id: cuid,
    type: callType,
    is_random: z.boolean().default(false),
  }),
  callParam: z.object({ id: cuid }),
  end: z.object({
    // Advisory only — the server times the call itself and ignores a client
    // duration. Accepted so the client can say *why* it hung up.
    reason: z
      .enum(['hungUp', 'rejected', 'cancelled', 'missed', 'networkError'])
      .default('hungUp'),
  }),
  rate: z.object({ rating: z.coerce.number().int().min(1).max(5) }),
  history: pagination.extend({
    direction: z.enum(['all', 'incoming', 'outgoing', 'missed']).default('all'),
  }),
};

// ── Wallet ──────────────────────────────────────────────────────────────────

const wallet = {
  purchase: z.object({
    package_id: z.string().trim().min(1),
    // The Google Play Billing purchase token — required on a deployment with
    // Google Play Billing wired in, verified server-side before anything is
    // credited (see `wallet.service.purchase`). Absent on a dev server with
    // no payment provider configured, which credits directly.
    purchase_token: z.string().trim().min(1).optional(),
  }),
  transactions: pagination.extend({
    kind: z
      .enum(['purchase', 'call', 'earning', 'withdrawal', 'bonus'])
      .optional(),
  }),
  withdraw: z.object({
    amount: z.coerce.number().positive('Enter an amount').optional(),
  }),
  vipPurchase: z.object({
    plan_id: z.string().trim().min(1),
    purchase_token: z.string().trim().min(1).optional(),
  }),
  upiAccount: z.object({
    upi_id: z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/, 'Enter a valid UPI ID'),
  }),
};

// ── Verification ────────────────────────────────────────────────────────────

const verification = {
  // The recording itself arrives as `req.file` via `verificationUpload`
  // (checked there and in `storage.service`), not through this schema —
  // there is no longer a `sample_url` a client can just hand the server a
  // URL for.
  submit: z.object({
    language_code: z.string().trim().min(1),
    duration_seconds: z.coerce.number().int().min(0).max(120),
  }),
};

// ── Moderation ──────────────────────────────────────────────────────────────

const moderation = {
  block: z.object({ user_id: cuid }),
  userParam: z.object({ id: cuid }),
  report: z.object({
    user_id: cuid,
    reason: z.string().trim().min(2).max(120),
    details: z.string().trim().max(1000).optional(),
    // Reporting and blocking almost always go together, so the client can ask
    // for both in one call.
    also_block: z.boolean().default(false),
  }),
};

// ── Notifications ───────────────────────────────────────────────────────────

const notifications = {
  list: pagination.extend({
    unread_only: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
  }),
  param: z.object({ id: cuid }),
};

// ── Favourites ──────────────────────────────────────────────────────────────

const favorites = {
  userParam: z.object({ id: cuid }),
};

module.exports = {
  auth,
  onboarding,
  profile,
  settings,
  reference,
  discovery,
  friends,
  chat,
  calls,
  wallet,
  verification,
  moderation,
  notifications,
  favorites,
  pagination,
};
