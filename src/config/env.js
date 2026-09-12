'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

/**
 * Configuration is read once, here, and validated at boot.
 *
 * A missing secret should stop the process on startup with a clear message,
 * not surface as an inscrutable JWT error on the first login attempt an hour
 * later. Nothing else in the codebase reads `process.env` directly.
 */

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable ${name}. Set it in .env.`);
  }
  return value.trim();
}

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, got "${raw}".`);
  }
  return parsed;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

/**
 * Is this value obviously a placeholder rather than a real secret?
 *
 * The `configured` checks below all ask whether a value is *present*, which a
 * placeholder satisfies perfectly. `LIVEKIT_API_SECRET=PASTE_YOUR_LIVEKIT_
 * SECRET_HERE` passed every guard below on that basis alone: the server
 * booted, minted call tokens signed with the literal string "PASTE_YOUR...",
 * and LiveKit rejected every one of them. Calls would ring, bill, and carry
 * no audio — the exact failure those guards exist to prevent, walked
 * straight through.
 */
function looksLikePlaceholder(value) {
  if (!value) return false;
  return /paste[_-]?your|your[_-]?(key|secret|token)[_-]?here|change[_-]?me|xxxx|<[^>]+>|replace[_-]?(this|me)/i.test(
    value
  );
}

/**
 * `NODE_ENV=test` is the one environment distinction this file still makes —
 * for automated test runs specifically (skipping request logging and rate
 * limiting so a fast test suite doesn't trip its own limiter), not for
 * "development versus production". There is no such thing here any more:
 * one `.env`, always held to the same requirements, wherever it runs.
 */
const isTest = process.env.NODE_ENV === 'test';

const env = {
  isTest,
  port: num('PORT', 4000),

  databaseUrl: required('DATABASE_URL'),

  jwt: {
    secret: required('JWT_SECRET'),
    refreshSecret: required('JWT_REFRESH_SECRET'),
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  },

  otp: {
    expirySeconds: num('OTP_EXPIRY', 300),
    length: num('OTP_LENGTH', 6),
    maxAttempts: num('OTP_MAX_ATTEMPTS', 5),
    resendCooldownSeconds: num('OTP_RESEND_COOLDOWN', 30),
    // Returns the code in the API response instead of sending it, so the app
    // (and the e2e test suite) is testable without an SMS gateway. A plain
    // flag, not a "dev mode" — whatever this says is exactly what happens,
    // wherever this file runs. The shipped app signs in through Firebase by
    // default anyway (see `ApiConfig.useFirebaseAuth`), which never touches
    // this path at all; turn this off if you also serve the OTP/MSG91 build
    // to real strangers.
    devMode: bool('OTP_DEV_MODE', false),
  },

  corsOrigin: (process.env.CORS_ORIGIN || '*')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),

  rateLimit: {
    windowMs: num('RATE_LIMIT_WINDOW_MS', 60_000),
    max: num('RATE_LIMIT_MAX', 120),
  },

  /**
   * Seeded profiles.
   *
   * `seed-demo.js` writes 22 complete accounts marked `isDemo` so a developer
   * has somebody to call. They are **not** people, so they must never appear
   * in a real user's discovery feed by accident — off by default, a plain flag
   * you turn on deliberately rather than something that happens to be true
   * because of which environment this looks like it's running in.
   *
   * There is deliberately no "answer for themselves" behaviour any more. It
   * used to exist (`DEMO_AUTO_RESPOND`) and it meant the server sent messages
   * and accepted calls that no human had authorised, which is indistinguishable
   * from the product lying to whoever was on the other end.
   */
  demo: {
    showSeededProfiles: bool('DEMO_SHOW_SEEDED_PROFILES', false),
  },

  economy: {
    /// The earner's cut of what a caller actually spent on a call — the
    /// other `1 - earnerShare` stays with the platform. Same 70/30 split as
    /// before; there is no unit conversion any more since spend and earnings
    /// are both plain rupees.
    earnerShare: num('EARNER_SHARE', 0.7),
    earningClearHours: num('EARNING_CLEAR_HOURS', 48),
    minWithdrawalInr: num('MIN_WITHDRAWAL_INR', 500),
  },

  /**
   * Locating a user by IP, when their phone cannot locate itself.
   *
   * The fallback for a handset with no GPS fix available — indoors, in a
   * village, with a broken receiver, or from someone who declined the
   * permission. An IP is accurate to roughly the level this product needs and
   * costs no permission at all.
   *
   * `none` by default, and deliberately: with `ipapi` every lookup sends a
   * user's IP address to a third party, and that should be a decision somebody
   * made rather than something that happened because a default was convenient.
   */
  geoip: {
    provider: (process.env.GEOIP_PROVIDER || 'none').trim().toLowerCase(),
    get configured() {
      return this.provider === 'ipapi';
    },
  },

  /**
   * State and district for a coordinate, once the phone has one.
   *
   * The client already has an on-device geocoder for a human-readable label,
   * but it is Google Play Services' own local database, and that database is
   * built for cities — a village-level fix routinely comes back with the
   * district field simply empty. Nominatim's boundary data is OpenStreetMap's
   * own administrative polygons, which for India are drawn down to district
   * level everywhere, not just where a city geocoder bothered to index.
   *
   * `none` by default, and deliberately: like the IP fallback above, `nominatim`
   * means every lookup sends a coordinate — a more precise thing than an IP —
   * to a third party, and that should be a decision somebody made.
   */
  reverseGeocode: {
    provider: (process.env.REVERSE_GEOCODE_PROVIDER || 'none').trim().toLowerCase(),
    get configured() {
      return this.provider === 'nominatim';
    },
    // Nominatim's usage policy requires a User-Agent that identifies the
    // application — a bare http-library default is refused.
    userAgent: process.env.NOMINATIM_USER_AGENT || 'Vybli/1.0',
  },

  /**
   * Who takes the money for a wallet recharge.
   *
   * `none` means no payment service provider is wired in, and the wallet is
   * credited directly with no payment taken — the ledger row says so
   * (`"no payment taken"`). That is real money-shaped behaviour, not a
   * sandboxed dev affordance: whatever `PAYMENT_PROVIDER` says in the one
   * `.env` this runs with is exactly what happens, wherever it runs. Set a
   * real provider before this is reachable by anyone you don't trust to not
   * call `POST /wallet/purchase` for free money.
   *
   * The only provider wired in is `google_play` — a purchase token the client
   * got from the Play Billing SDK, verified server-to-server against the Play
   * Developer API before anything is credited; see the `verify against Play`
   * branch in `wallet.service.purchase`. Nothing else in the flow changes:
   * the price already comes from the database rather than the request.
   */
  payments: {
    provider: (process.env.PAYMENT_PROVIDER || 'none').trim().toLowerCase(),
    get configured() {
      return this.provider !== 'none' && this.provider !== '';
    },
    /// True whenever no provider is configured — see the doc comment above.
    get creditsWithoutPayment() {
      return !this.configured;
    },
    /**
     * Google Play Billing: collection for recharge/VIP purchases on Android.
     *
     * A purchase is verified server-to-server against the Play Developer API
     * using a service account — `packageName` says which app's purchases to
     * trust, the service account credentials authenticate the call. Nothing
     * here is handed to the client; unlike a payment gateway's public key,
     * Play Billing needs no client-side secret at all — the Play Store app
     * itself is what the client talks to.
     */
    googlePlay: {
      packageName: (process.env.PLAY_BILLING_PACKAGE_NAME || '').trim(),
      serviceAccountEmail: (process.env.PLAY_BILLING_SERVICE_ACCOUNT_EMAIL || '').trim(),
      // Kept untrimmed: the PEM's own newlines matter, same as Firebase's key below.
      serviceAccountPrivateKey: process.env.PLAY_BILLING_SERVICE_ACCOUNT_PRIVATE_KEY || '',
      get configured() {
        return Boolean(
          this.packageName && this.serviceAccountEmail && this.serviceAccountPrivateKey
        );
      },
    },
  },

  /**
   * Firebase, used only to verify phone numbers.
   *
   * **The project id alone is enough.** Verifying an ID token means checking a
   * signature against Google's *public* certificates and then checking the
   * claims — none of which needs a credential. A service account is only
   * required for privileged calls (minting custom tokens, disabling users,
   * reading a user record), and this server makes none of them.
   *
   * That is worth taking: it means no private key to store, leak or rotate.
   *
   * A service account may still be supplied. When it is, [verifyPhoneToken]
   * additionally checks whether the Firebase user has been revoked — the one
   * thing the public path cannot do.
   *
   * Not required to boot on its own: with an SMS provider configured the OTP
   * path works without it, and the test suite uses that path. What the guard
   * below refuses is having *neither*.
   */
  firebase: {
    projectId: (process.env.FIREBASE_PROJECT_ID || '').trim(),
    clientEmail: (process.env.FIREBASE_CLIENT_EMAIL || '').trim(),
    // Kept untrimmed: the PEM's own newlines matter.
    privateKey: process.env.FIREBASE_PRIVATE_KEY || '',

    /// How old a Firebase sign-in may be before this server stops accepting
    /// it. Firebase ID tokens live an hour; a token replayed forty minutes
    /// after it was minted is not somebody signing in, and without a service
    /// account there is no revocation check to catch it. Ten minutes is
    /// generous for a slow network and someone typing a code.
    maxAuthAgeSeconds: num('FIREBASE_MAX_AUTH_AGE', 600),

    get configured() {
      return Boolean(this.projectId);
    },
    /// Whether the extra, credentialed checks are available.
    get hasServiceAccount() {
      return Boolean(this.projectId && this.clientEmail && this.privateKey);
    },
  },

  /**
   * Who carries the OTP.
   *
   * [configured] rather than a feature flag: with no provider set, `deliver`
   * below prints the code to the terminal instead of sending it, if
   * `OTP_DEV_MODE` is on — otherwise the OTP path simply cannot send
   * anything. Either way, the boot guard below refuses to start with no way
   * for anyone to sign in at all (see [firebase] above for the other one),
   * because an API where nobody can sign in is not a running API.
   */
  sms: {
    provider: (process.env.SMS_PROVIDER || 'msg91').trim(),
    msg91: {
      authKey: (process.env.MSG91_AUTH_KEY || '').trim(),
      templateId: (process.env.MSG91_TEMPLATE_ID || '').trim(),
      senderId: (process.env.MSG91_SENDER_ID || '').trim(),
      /// The variable name in the DLT template — `var1`, `otp`, whatever the
      /// MSG91 dashboard shows. Getting this wrong sends an empty message.
      otpVariable: (process.env.MSG91_OTP_VAR || 'var1').trim(),
    },
    get configured() {
      if (this.provider === 'msg91') {
        return Boolean(this.msg91.authKey && this.msg91.templateId);
      }
      return false;
    },
  },

  /**
   * The single administrator.
   *
   * One static credential, held here and compared server-side. There is no
   * admin table, no registration and no second account — which is a deliberate
   * simplification, not an omission: a one-person admin panel with a users
   * table, a roles table and a permissions matrix is three tables of ceremony
   * around a single `if`.
   *
   * The password never reaches the frontend and is never written to Postgres.
   * It may be supplied already bcrypt-hashed via ADMIN_PASSWORD_HASH, which is
   * what a real deployment should do — a plaintext password in an environment
   * variable is readable by anything that can read the process environment.
   */
  admin: {
    username: (process.env.ADMIN_USERNAME || '').trim(),
    password: process.env.ADMIN_PASSWORD || '',
    passwordHash: (process.env.ADMIN_PASSWORD_HASH || '').trim(),
    jwtSecret: (process.env.ADMIN_JWT_SECRET || '').trim(),
    /// Accepts `8h`, `30m`, `7d` — anything jsonwebtoken understands.
    sessionExpiry: (process.env.ADMIN_SESSION_EXPIRY || '8h').trim(),
    /// Wrong passwords allowed before the source address is locked out.
    maxFailedLogins: num('ADMIN_MAX_FAILED_LOGINS', 5),
    lockoutMinutes: num('ADMIN_LOCKOUT_MINUTES', 15),
    get configured() {
      return Boolean(this.username && (this.password || this.passwordHash) && this.jwtSecret);
    },
  },

  /**
   * LiveKit carries the actual audio and video.
   *
   * Everything else about a call — who may ring whom, the billing clock, the
   * history row — is this server's. LiveKit's only job is the media path, and
   * it is given exactly one room per call with a token scoped to it.
   *
   * [configured] used by the admin panel to decide what it can show, but the
   * boot guard below refuses to start without real credentials at all — a
   * call that rings and bills in silence is worse than no call, and there is
   * no lesser mode this server runs in where that would be acceptable.
   */
  livekit: {
    url: (process.env.LIVEKIT_URL || '').trim(),
    apiKey: (process.env.LIVEKIT_API_KEY || '').trim(),
    apiSecret: (process.env.LIVEKIT_API_SECRET || '').trim(),
    /// How long a join token stays valid. Only needs to cover the walk from
    /// "the phone rang" to "the room is joined"; the session outlives it.
    tokenTtlSeconds: num('LIVEKIT_TOKEN_TTL', 900),
    /// Rooms are torn down explicitly when a call ends. This is the backstop
    /// for a room the server somehow never closed.
    emptyTimeoutSeconds: num('LIVEKIT_EMPTY_TIMEOUT', 120),
    get configured() {
      return Boolean(this.url && this.apiKey && this.apiSecret);
    },
  },
};

// Guard rails, checked at boot rather than left as a comment nobody reads.
//
// Unconditional — there is no "development" reading of this file that gets
// to skip them. `OTP_DEV_MODE` and an unconfigured `PAYMENT_PROVIDER` are the
// two deliberate exceptions (see their own doc comments above): real,
// permanent flags this file controls directly, not a relaxation tied to
// which environment this looks like it's running in.
if (env.jwt.secret === env.jwt.refreshSecret) {
  throw new Error(
    'JWT_SECRET and JWT_REFRESH_SECRET must differ, or a refresh token would pass as an access token.'
  );
}
if (env.jwt.secret.startsWith('change-me')) {
  throw new Error('JWT_SECRET is still the example value.');
}
if (env.corsOrigin.includes('*')) {
  // Not a boot-time throw, by request: this API's real clients (the Flutter
  // app, curl, Postman) never send a browser CORS preflight at all — CORS
  // is a browser-only restriction on which *origins* may read a response,
  // and every request here still needs a valid Bearer token regardless of
  // origin. Wildcarding it only widens which *websites* could read a
  // response on behalf of a signed-in browser tab (the admin panel, once
  // deployed) — worth knowing, not worth refusing to boot over.
  console.warn(
    '[boot] CORS_ORIGIN is "*". Fine for the mobile app, which never sends a ' +
      "CORS preflight — but any website can then read this API's responses " +
      "from a signed-in browser tab. Set it to the admin panel's real origin " +
      'once that has a domain.'
  );
}
if (!env.payments.configured) {
  // Not a boot-time throw: `wallet.service.purchase` already refuses the
  // request at runtime once a provider is configured (`creditsWithoutPayment`
  // is false the moment `payments.configured` is true), so this is purely
  // informational.
  console.warn(
    '[boot] PAYMENT_PROVIDER is not set. Recharge currently credits the ' +
      'wallet with no payment taken — see the doc comment on `payments` above.'
  );
}
if (env.payments.provider === 'google_play' && !env.payments.googlePlay.configured) {
  throw new Error(
    'PAYMENT_PROVIDER=google_play but PLAY_BILLING_PACKAGE_NAME, ' +
      'PLAY_BILLING_SERVICE_ACCOUNT_EMAIL and PLAY_BILLING_SERVICE_ACCOUNT_PRIVATE_KEY ' +
      'are not all set — without them a purchase token cannot be verified against the ' +
      'Play Developer API.'
  );
}
for (const [name, value] of [
  ['JWT_SECRET', env.jwt.secret],
  ['JWT_REFRESH_SECRET', env.jwt.refreshSecret],
  ['LIVEKIT_API_KEY', env.livekit.apiKey],
  ['LIVEKIT_API_SECRET', env.livekit.apiSecret],
  ['ADMIN_PASSWORD', env.admin.password],
  ['ADMIN_JWT_SECRET', env.admin.jwtSecret],
  ...(env.payments.provider === 'google_play'
    ? [
        ['PLAY_BILLING_PACKAGE_NAME', env.payments.googlePlay.packageName],
        ['PLAY_BILLING_SERVICE_ACCOUNT_EMAIL', env.payments.googlePlay.serviceAccountEmail],
      ]
    : []),
]) {
  if (looksLikePlaceholder(value)) {
    throw new Error(
      `${name} is still a placeholder ("${value}"). It is present, which is why every ` +
        'other check passed, but it is not a credential — whatever it authenticates ' +
        'would reject it at the first real request.'
    );
  }
}

if (!env.livekit.configured) {
  throw new Error(
    'LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are required — without them ' +
      'calls ring and bill but carry no audio.'
  );
}
if (env.livekit.url.startsWith('ws://')) {
  throw new Error('LIVEKIT_URL must be wss://, not ws://.');
}
if (!env.admin.configured) {
  throw new Error(
    'ADMIN_USERNAME, ADMIN_PASSWORD (or ADMIN_PASSWORD_HASH) and ADMIN_JWT_SECRET are ' +
      'required — the admin panel is unreachable without them.'
  );
}
if (env.admin.jwtSecret === env.jwt.secret) {
  throw new Error(
    'ADMIN_JWT_SECRET must differ from JWT_SECRET, or a user token would pass as an admin one.'
  );
}
if (!env.sms.configured && !env.firebase.configured) {
  throw new Error(
    'No way for anyone to sign in. Configure either Firebase ' +
      '(FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY) ' +
      'or an SMS provider (MSG91_AUTH_KEY, MSG91_TEMPLATE_ID).'
  );
}
if (env.admin.password && !env.admin.passwordHash) {
  console.warn(
    '[boot] ADMIN_PASSWORD is set in plaintext. Prefer ADMIN_PASSWORD_HASH ' +
      '(bcrypt) so the password is not readable from the process environment.'
  );
}

module.exports = env;
