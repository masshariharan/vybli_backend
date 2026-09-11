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
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`
    );
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
 * SECRET_HERE` passed every production guard: the server booted, minted call
 * tokens signed with the literal string "PASTE_YOUR...", and LiveKit rejected
 * every one of them. Calls would ring, bill, and carry no audio — the exact
 * failure those guards exist to prevent, walked straight through.
 */
function looksLikePlaceholder(value) {
  if (!value) return false;
  return /paste[_-]?your|your[_-]?(key|secret|token)[_-]?here|change[_-]?me|xxxx|<[^>]+>|replace[_-]?(this|me)/i.test(
    value
  );
}

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';

const env = {
  nodeEnv,
  isProduction,
  isTest: nodeEnv === 'test',
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
    // Returning the code in the API response is a development affordance so
    // the app is testable without an SMS gateway. Refused in production below.
    devMode: bool('OTP_DEV_MODE', !isProduction),
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
   * in a real user's discovery feed — the flag below is what keeps them out,
   * and it is forced off in production regardless of what the environment
   * says.
   *
   * There is deliberately no "answer for themselves" behaviour any more. It
   * used to exist (`DEMO_AUTO_RESPOND`) and it meant the server sent messages
   * and accepted calls that no human had authorised, which is indistinguishable
   * from the product lying to whoever was on the other end.
   */
  demo: {
    showSeededProfiles: isProduction ? false : bool('DEMO_SHOW_SEEDED_PROFILES', true),
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
   * `none` means no payment service provider is wired in. On a development
   * machine that credits the wallet directly so the wallet screens have a
   * ledger to render; **in production it makes the endpoint refuse**, because
   * the alternative — the behaviour this replaced — was an authenticated HTTP
   * call that credited money for free.
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
    /// True only where crediting a wallet without a payment is acceptable.
    get creditsWithoutPayment() {
      return !this.configured && !isProduction;
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
   * Not required to boot: with an SMS provider configured the OTP path works
   * on its own, and the test suite uses it. What production refuses is having
   * *neither* — see the guard below.
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
   * [configured] rather than a feature flag: a development machine with no
   * provider still boots and prints codes to the terminal. Production refuses
   * to start without one, because an API where nobody can sign in is not a
   * running API.
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
   * [configured] rather than a feature flag: the integration is not optional,
   * but a development machine without credentials should still be able to run
   * the rest of the API. Production refuses to boot without them, below,
   * because a call that rings and bills in silence is worse than no call.
   */
  /**
   * Where profile photos are stored.
   *
   * `driver` is `s3` for any S3-compatible object store — Cloudflare R2, AWS
   * S3, Backblaze B2, MinIO — and `local` for files on this machine's disk.
   *
   * Local is a development affordance and production refuses it below. A
   * container filesystem does not survive a redeploy, so every deploy would
   * delete every photo while the database went on pointing at them: broken
   * images for every user, and no error anywhere to explain it.
   */
  storage: {
    driver: (process.env.STORAGE_DRIVER || 'local').trim(),
    bucket: (process.env.STORAGE_BUCKET || '').trim(),
    /// R2, MinIO and B2 need this. Real AWS S3 derives it from the region.
    endpoint: (process.env.STORAGE_ENDPOINT || '').trim(),
    /// R2 ignores regions but the SDK requires one; `auto` is R2's convention.
    region: (process.env.STORAGE_REGION || 'auto').trim(),
    accessKeyId: (process.env.STORAGE_ACCESS_KEY_ID || '').trim(),
    secretAccessKey: (process.env.STORAGE_SECRET_ACCESS_KEY || '').trim(),
    /// The origin photos are *served* from, which is rarely the origin they
    /// are written to: R2 writes to an account endpoint and reads through a
    /// public bucket domain or a CDN in front of it.
    publicUrl: (process.env.STORAGE_PUBLIC_URL || '').trim(),
    forcePathStyle: bool('STORAGE_FORCE_PATH_STYLE', true),
    /// Generous for a phone photo, small enough that a hostile client cannot
    /// use the endpoint as free storage. Enforced again by multer, so the
    /// bytes never fully arrive.
    maxBytes: num('STORAGE_MAX_BYTES', 8 * 1024 * 1024),
    /// A verification clip is at most 15 seconds of uncompressed WAV — a few
    /// megabytes even at CD quality — so this has headroom to spare without
    /// coming close to what would let the endpoint be used as free storage.
    verificationMaxBytes: num('STORAGE_VERIFICATION_MAX_BYTES', 10 * 1024 * 1024),
    get configured() {
      if (this.driver === 'local') return Boolean(this.publicUrl);
      return Boolean(
        this.bucket && this.accessKeyId && this.secretAccessKey && this.publicUrl
      );
    },
  },

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

// The local driver serves photos off this same server, so its URLs are
// *relative* and a development machine needs no storage configuration at all.
//
// Relative rather than absolute because this server cannot know the address it
// is reached by. A phone on a LAN calls it at `10.x:4000`, the emulator at
// `10.0.2.2:4000`, and a browser at `localhost:4000` — all three at once, and
// an absolute URL baked at boot is wrong for two of them. Clients resolve a
// relative photo URL against the API origin they already hold, which is by
// definition the address that reached the server.
//
// S3 URLs stay absolute: a CDN domain is the same from everywhere.
if (env.storage.driver === 'local' && !env.storage.publicUrl) {
  env.storage.publicUrl = '/uploads';
}

// Guard rails that only matter in production, checked at boot rather than
// left as a comment nobody reads.
if (isProduction) {
  if (env.otp.devMode) {
    throw new Error(
      'OTP_DEV_MODE must be false in production — it returns the OTP in the API response.'
    );
  }
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
      '[boot] CORS_ORIGIN is "*" in production. Fine for the mobile app, which ' +
        'never sends a CORS preflight — but any website can then read this ' +
        "API's responses from a signed-in browser tab. Set it to the admin " +
        "panel's real origin once that has a domain."
    );
  }
  if (!env.payments.configured) {
    // Not a boot-time throw: `wallet.service.purchase` refuses the request at
    // runtime instead (`creditsWithoutPayment` is false whenever isProduction
    // is true, regardless of provider), so recharge already fails safely with
    // "payments unavailable" rather than crediting for free. Deferring
    // PAYMENT_PROVIDER to a later deploy should not take the rest of the API
    // down with it.
    console.warn(
      '[boot] PAYMENT_PROVIDER is not set. The recharge endpoint will refuse ' +
        'every purchase with "payments unavailable" until PAYMENT_PROVIDER is configured.'
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
    ['STORAGE_ACCESS_KEY_ID', env.storage.accessKeyId],
    ['STORAGE_SECRET_ACCESS_KEY', env.storage.secretAccessKey],
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
      'LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are required in production — ' +
        'without them calls ring and bill but carry no audio.'
    );
  }
  if (env.livekit.url.startsWith('ws://')) {
    throw new Error('LIVEKIT_URL must be wss:// in production, not ws://.');
  }
  if (env.storage.driver !== 's3') {
    throw new Error(
      'STORAGE_DRIVER must be "s3" in production. The local driver writes to this ' +
        "machine's disk, which does not survive a redeploy — every profile photo " +
        'would vanish while the database kept pointing at it.'
    );
  }
  if (!env.storage.configured) {
    throw new Error(
      'STORAGE_BUCKET, STORAGE_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY and ' +
        'STORAGE_PUBLIC_URL are required in production — without them nobody can ' +
        'upload a profile photo.'
    );
  }
  if (env.storage.publicUrl.startsWith('http://')) {
    throw new Error(
      'STORAGE_PUBLIC_URL must be https:// in production — the app blocks cleartext.'
    );
  }
  if (!env.admin.configured) {
    throw new Error(
      'ADMIN_USERNAME, ADMIN_PASSWORD (or ADMIN_PASSWORD_HASH) and ADMIN_JWT_SECRET are ' +
        'required in production — the admin panel is unreachable without them.'
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
} else {
  // The placeholder check above only runs in production, which is exactly
  // how `LIVEKIT_API_SECRET=PASTE_YOUR_LIVEKIT_SECRET_HERE` walked straight
  // through every guard here: `configured` only asks whether the string is
  // non-empty, so the server booted, minted tokens signed with the literal
  // placeholder, and LiveKit rejected every one — a call that rings, bills,
  // and carries no audio, with nothing at boot to say why.
  //
  // Development still has to boot without real credentials, so this warns
  // instead of throwing — but it warns, rather than leaving the same mistake
  // to be found by hand, minutes of silent calls later.
  for (const [name, value] of [
    ['LIVEKIT_API_KEY', env.livekit.apiKey],
    ['LIVEKIT_API_SECRET', env.livekit.apiSecret],
    ['JWT_SECRET', env.jwt.secret],
    ['JWT_REFRESH_SECRET', env.jwt.refreshSecret],
    ['STORAGE_ACCESS_KEY_ID', env.storage.accessKeyId],
    ['STORAGE_SECRET_ACCESS_KEY', env.storage.secretAccessKey],
    ['ADMIN_PASSWORD', env.admin.password],
    ['ADMIN_JWT_SECRET', env.admin.jwtSecret],
  ]) {
    if (looksLikePlaceholder(value)) {
      console.warn(
        `[boot] ${name} looks like a placeholder ("${value}") rather than a real ` +
          'credential. The server will start, but whatever this authenticates against ' +
          'will reject it at the first real request.'
      );
    }
  }
}

module.exports = env;
