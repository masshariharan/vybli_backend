'use strict';

/**
 * A failure the client is allowed to see.
 *
 * Every one carries a stable machine-readable `code` alongside the human
 * message. The Flutter app switches on the code — messages get reworded, and a
 * client that branches on prose breaks the day someone fixes a typo.
 */
class AppError extends Error {
  constructor(message, { status = 400, code = 'BAD_REQUEST', details } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    // Marks this as deliberate, so the error handler knows the message is safe
    // to send back rather than something that leaked out of a driver.
    this.expose = true;
    Error.captureStackTrace?.(this, AppError);
  }
}

/** Factories for the failures this API actually produces. */
const errors = {
  // ── 400 ──────────────────────────────────────────────────────────────────
  badRequest: (message = 'Invalid request', details) =>
    new AppError(message, { status: 400, code: 'BAD_REQUEST', details }),

  validation: (details, message = 'Some fields need your attention') =>
    new AppError(message, { status: 422, code: 'VALIDATION_ERROR', details }),

  // ── 401 / 403 ────────────────────────────────────────────────────────────
  unauthorized: (message = 'Please sign in to continue') =>
    new AppError(message, { status: 401, code: 'UNAUTHORIZED' }),

  invalidToken: (message = 'Your session has expired. Please sign in again.') =>
    new AppError(message, { status: 401, code: 'INVALID_TOKEN' }),

  forbidden: (message = 'You cannot do that', code = 'FORBIDDEN') =>
    new AppError(message, { status: 403, code }),

  accountSuspended: () =>
    new AppError('This account has been suspended.', {
      status: 403,
      code: 'ACCOUNT_SUSPENDED',
    }),

  onboardingIncomplete: (nextStatus) =>
    new AppError('Finish setting up your account first.', {
      status: 403,
      code: 'ONBOARDING_INCOMPLETE',
      details: { next_status: nextStatus },
    }),

  // ── 404 / 409 ────────────────────────────────────────────────────────────
  notFound: (what = 'Resource', code = 'NOT_FOUND') =>
    new AppError(`${what} not found`, { status: 404, code }),

  conflict: (message, code = 'CONFLICT') =>
    new AppError(message, { status: 409, code }),

  // ── 429 ──────────────────────────────────────────────────────────────────
  tooManyRequests: (message = 'Too many attempts. Please wait a moment.', details) =>
    new AppError(message, { status: 429, code: 'RATE_LIMITED', details }),

  // ── 500 ──────────────────────────────────────────────────────────────────
  internal: (message = 'Something went wrong on our end') =>
    new AppError(message, { status: 500, code: 'INTERNAL_ERROR' }),

  /**
   * The provider would not take the message.
   *
   * Deliberately vague to the user and specific in the log: "the template is
   * not approved" is our problem to fix, not something they can act on, and
   * the detail belongs where an engineer will read it.
   */
  smsDeliveryFailed: () =>
    new AppError('We could not send the code right now. Please try again in a moment.', {
      status: 502,
      code: 'SMS_DELIVERY_FAILED',
    }),

  /**
   * The Play Developer API itself could not be reached or answered — not the
   * purchase being invalid, but Google's own infrastructure or this server's
   * credentials.
   *
   * Deliberately vague to the user and specific in the log, like
   * `smsDeliveryFailed` above: a bad service-account key, a network blip and
   * a scope Google rejects all look identical from here, and none of them is
   * something the user can act on. This is also what stands between the raw
   * API error and the client — a 401 from a bad credential must never reach
   * `errorHandler` unwrapped, or a misconfigured service account would look
   * to the app like the user's own session had expired.
   */
  paymentProviderError: () =>
    new AppError('We could not start your payment right now. Please try again in a moment.', {
      status: 502,
      code: 'PAYMENT_PROVIDER_ERROR',
    }),

  // ── Admin ────────────────────────────────────────────────────────────────
  // Their own factories rather than a `code` argument bolted onto the generic
  // ones: the admin panel distinguishes "wrong password", "locked out" and
  // "session expired" in the UI, and each needs a stable code to key off.

  adminUnauthorized: (message = 'Not signed in as the administrator.', code = 'ADMIN_UNAUTHORIZED') =>
    new AppError(message, { status: 401, code }),

  adminLockedOut: (seconds) =>
    new AppError(
      `Too many failed attempts. Try again in ${Math.ceil(seconds / 60)} minutes.`,
      { status: 429, code: 'ADMIN_LOCKED_OUT', details: { retry_after_seconds: seconds } }
    ),

  adminNotConfigured: () =>
    new AppError('The admin panel is not configured on this server.', {
      status: 503,
      code: 'ADMIN_NOT_CONFIGURED',
    }),

  // ── Domain-specific, named so call sites read as the rule they enforce ───

  /** OTP */
  otpInvalid: () =>
    new AppError('That code is incorrect. Please try again.', {
      status: 400,
      code: 'OTP_INVALID',
    }),
  otpExpired: () =>
    new AppError('This code has expired. Request a new one.', {
      status: 400,
      code: 'OTP_EXPIRED',
    }),
  otpTooManyAttempts: () =>
    new AppError('Too many incorrect attempts. Request a new code.', {
      status: 429,
      code: 'OTP_TOO_MANY_ATTEMPTS',
    }),
  otpCooldown: (seconds) =>
    new AppError(`Please wait ${seconds}s before requesting another code.`, {
      status: 429,
      code: 'OTP_COOLDOWN',
      details: { retry_after_seconds: seconds },
    }),

  /** Friend requests */
  requestToSelf: () =>
    new AppError('You cannot send a request to yourself.', {
      status: 400,
      code: 'REQUEST_TO_SELF',
    }),
  requestExists: () =>
    new AppError('A friend request already exists.', {
      status: 409,
      code: 'FRIEND_REQUEST_EXISTS',
    }),
  alreadyFriends: () =>
    new AppError('You are already friends.', {
      status: 409,
      code: 'ALREADY_FRIENDS',
    }),
  notAnEarner: () =>
    new AppError(
      'Only Earn Money profiles can receive friend requests.',
      { status: 400, code: 'RECIPIENT_NOT_EARNER' }
    ),
  senderIsEarner: () =>
    new AppError(
      'Earn Money accounts receive friend requests rather than send them.',
      { status: 400, code: 'SENDER_IS_EARNER' }
    ),

  /** Blocking */
  blocked: () =>
    new AppError('This is not available between you and this person.', {
      status: 403,
      code: 'BLOCKED',
    }),

  /** Messaging */
  notFriends: () =>
    new AppError('You can message someone once they accept your friend request.', {
      status: 403,
      code: 'NOT_FRIENDS',
    }),
  messagingDisabledByMe: () =>
    new AppError('Messaging is switched off in your privacy settings.', {
      status: 403,
      code: 'MESSAGING_DISABLED_SELF',
    }),
  messagingDisabledByThem: () =>
    new AppError('This person is not accepting messages.', {
      status: 403,
      code: 'MESSAGING_DISABLED_PEER',
    }),

  /** Calls */
  callTypeDisabled: (type) =>
    new AppError(`This person has ${type} calls switched off.`, {
      status: 403,
      code: 'CALL_TYPE_DISABLED',
    }),
  calleeOffline: () =>
    new AppError('This person is offline right now.', {
      status: 409,
      code: 'CALLEE_OFFLINE',
    }),
  calleeBusy: () =>
    new AppError('This person is on another call right now.', {
      status: 409,
      code: 'CALLEE_BUSY',
    }),
  callerBusy: () =>
    new AppError('You are already on a call.', {
      status: 409,
      code: 'CALLER_BUSY',
    }),
  noMatchAvailable: () =>
    new AppError('No one is available right now. Try a wider city selection.', {
      status: 404,
      code: 'NO_MATCH_AVAILABLE',
    }),
  callRoleMismatch: () =>
    new AppError(
      'A call must connect an Earn Money account with a Make Friends account.',
      { status: 400, code: 'CALL_ROLE_MISMATCH' }
    ),

  /** Wallet */
  insufficientBalance: (required, balance) =>
    new AppError('You do not have enough balance for this call.', {
      status: 402,
      code: 'INSUFFICIENT_BALANCE',
      details: { required, balance },
    }),
  paymentFailed: (message = 'Your bank declined the payment. No money was deducted.') =>
    new AppError(message, { status: 402, code: 'PAYMENT_FAILED' }),
  /** The client named a Play Billing purchase but sent no purchase token with it. */
  purchaseTokenRequired: () =>
    new AppError('This purchase could not be verified.', {
      status: 400,
      code: 'PURCHASE_TOKEN_REQUIRED',
    }),
  /**
   * The Play Developer API does not consider this token a completed
   * purchase of the product claimed — cancelled, refunded, pending, or a
   * token Google simply does not recognise. Never thrown for a network or
   * credential failure talking to Google; see `paymentProviderError` for
   * that case instead.
   */
  purchaseNotVerified: () =>
    new AppError('We could not verify this purchase. No money was added.', {
      status: 402,
      code: 'PURCHASE_NOT_VERIFIED',
    }),
  /**
   * No payment provider is wired in on this deployment.
   *
   * 503 rather than 402: the bank did not decline anything, the feature is
   * simply not available here. The client shows "temporarily unavailable"
   * instead of "your card was refused", which would be a lie about the user's
   * bank.
   */
  paymentsUnavailable: () =>
    new AppError('Recharges are temporarily unavailable. Please try again later.', {
      status: 503,
      code: 'PAYMENTS_UNAVAILABLE',
    }),
  withdrawalBelowMinimum: (minimum) =>
    new AppError(`You need at least ₹${minimum} to withdraw.`, {
      status: 400,
      code: 'WITHDRAWAL_BELOW_MINIMUM',
      details: { minimum },
    }),
  notAnEarnerAccount: () =>
    new AppError('Only Earn Money accounts have earnings.', {
      status: 403,
      code: 'NOT_EARNER_ACCOUNT',
    }),
  withdrawalRequiresVerification: () =>
    new AppError('Your account must be verified before withdrawing.', {
      status: 403,
      code: 'WITHDRAWAL_REQUIRES_VERIFICATION',
    }),
  withdrawalRequiresUpiAccount: () =>
    new AppError('Add a UPI ID before withdrawing.', {
      status: 403,
      code: 'WITHDRAWAL_REQUIRES_UPI_ID',
    }),
};

module.exports = { AppError, errors };
