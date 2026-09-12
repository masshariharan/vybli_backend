'use strict';

const prisma = require('../config/prisma');
const { errors } = require('../utils/errors');
const otpService = require('./otp.service');
const firebase = require('./firebase.service');
const activity = require('./activity.service');
const { emitToAdmin } = require('../sockets/bus');
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashToken,
  refreshTokenTtlMs,
} = require('../utils/tokens');

/**
 * Sessions.
 *
 * Sign-up and sign-in are the same call. The app asks for a phone number and a
 * code; whether a row already exists is the server's business, not a question
 * to put to someone who just wants to get in. A first-time number gets an
 * account, its settings rows and an empty wallet in one transaction — a user
 * who exists without a wallet is a null dereference waiting on the first call
 * screen.
 */

const USER_INCLUDE = {
  profile: { include: { city: true } },
  privacySettings: true,
  languages: true,
};

/** Step one: text a code to the number. */
async function requestOtp({ dialCode, phone }) {
  // Normalised here as well as on verify, and for the same reason both must
  // agree: a code stored against `09876543210` cannot be found by a verify
  // that looked up `9876543210`. One canonical form, decided at the edge.
  const number = firebase.normalise({ dialCode, phone });

  const existing = await findLiveUser(number);
  if (existing?.status === 'suspended') throw errors.accountSuspended();

  const { expiresAt, devCode } = await otpService.requestOtp(number);

  return {
    expires_at: expiresAt.toISOString(),
    // Lets the client show "Welcome back" rather than "Create your account".
    is_existing_user: Boolean(existing),
    dev_code: devCode,
  };
}

function findLiveUser({ dialCode, phone }) {
  return prisma.user.findFirst({
    where: { dialCode, phone, deletedAt: null },
    include: USER_INCLUDE,
  });
}

/**
 * Step two: check the code, then hand back a session.
 *
 * Everything a fresh account needs is created together. `PHONE_VERIFIED` is
 * the starting onboarding status, so the client knows to show the gender step
 * rather than the feed.
 */
async function verifyOtpAndSignIn({ dialCode, phone, code, device, ip }) {
  const number = firebase.normalise({ dialCode, phone });
  await otpService.verifyOtp({ ...number, code });
  return establishSession({ ...number, device, ip, via: 'otp' });
}

/**
 * Signs in with a Firebase ID token instead of our own OTP.
 *
 * Firebase is used purely as a phone-verification oracle: it tells us the
 * person controls the number, and everything after that is identical to the
 * OTP path — same lookup, same account creation, same session. The Firebase
 * UID is deliberately **not** stored as an identity. Nothing in this codebase
 * keys off it, which is what keeps switching providers a one-file change.
 */
async function signInWithFirebase({ idToken, device, ip }) {
  // Everything here comes out of the *verified* token, never off the request
  // body. The client sends one opaque string and cannot influence which
  // account it lands on: the phone number and the UID are read from claims
  // Google signed.
  const { dialCode, phone, firebaseUid } = await firebase.verifyPhoneToken(idToken);
  return establishSession({ dialCode, phone, firebaseUid, device, ip, via: 'firebase' });
}

/**
 * Finds or creates the account behind a **verified** phone number, and opens a
 * session for it.
 *
 * Shared by both sign-in paths on purpose. When OTP and Firebase each had
 * their own copy of "create the user, make the wallet, record the activity",
 * the two would drift — and the drift would be silent, because whichever path
 * the tests exercise is the one that stays correct.
 *
 * The caller is responsible for having verified the number. This function
 * trusts it completely.
 */
async function establishSession({ dialCode, phone, firebaseUid, device, ip, via }) {
  let user = await findLiveUser({ dialCode, phone });
  let isNewUser = false;

  if (!user) {
    isNewUser = true;
    user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          dialCode,
          phone,
          firebaseUid: firebaseUid ?? null,
          wallet: { create: {} },
          privacySettings: { create: {} },
          notificationSettings: { create: {} },
          discoverySettings: { create: {} },
        },
      });

      // A placeholder profile, so no downstream read has to cope with a user
      // that has none. Onboarding fills it in and flips the status as it goes.
      await tx.userProfile.create({
        data: {
          userId: created.id,
          name: '',
          age: 18,
          gender: 'female',
          onboardingStatus: 'PHONE_VERIFIED',
        },
      });

      return tx.user.findUnique({ where: { id: created.id }, include: USER_INCLUDE });
    });
  } else if (user.status === 'suspended') {
    throw errors.accountSuspended();
  }

  // Kept current on every Firebase sign-in, not just the first. A UID that has
  // changed for a number we already know means the Firebase identity behind it
  // was recreated — or that the number was reassigned to somebody else, which
  // is the case worth being able to see afterwards.
  if (firebaseUid && user.firebaseUid !== firebaseUid) {
    const previous = user.firebaseUid;
    await prisma.user.update({ where: { id: user.id }, data: { firebaseUid } });
    user.firebaseUid = firebaseUid;

    if (previous) {
      activity.record({
        userId: user.id,
        type: 'otp_verified',
        description: 'Signed in with a different Firebase identity than last time',
        metadata: { previous_firebase_uid: previous, firebase_uid: firebaseUid, ip: ip ?? null },
      });
    }
  }

  const tokens = await issueSession(user, { device, ip });

  // Two separate facts, and the admin timeline needs both: the account came
  // into existence, and somebody signed in. On a first sign-in they happen at
  // the same instant but they are not the same event.
  if (isNewUser) {
    activity.record({
      userId: user.id,
      type: 'registration',
      description: `Account created for ${dialCode} ${phone}`,
      metadata: {
        dial_code: dialCode,
        ip: ip ?? null,
        device: device ?? null,
        via,
        firebase_uid: firebaseUid ?? null,
      },
    });
  }
  activity.record({
    userId: user.id,
    type: 'otp_verified',
    description:
      via === 'firebase'
        ? 'Phone number verified by Firebase'
        : 'Phone number verified by OTP',
    metadata: { ip: ip ?? null, via },
  });
  activity.record({
    userId: user.id,
    type: 'login',
    description: device ? `Signed in from ${device}` : 'Signed in',
    metadata: { ip: ip ?? null, device: device ?? null, via },
  });

  emitToAdmin(isNewUser ? 'admin:user_registered' : 'admin:user_signed_in', {
    user_id: user.id,
    name: user.profile?.name ?? null,
    phone: `${dialCode} ${phone}`,
    via,
    at: new Date().toISOString(),
  });

  return {
    ...tokens,
    is_new_user: isNewUser,
    onboarding_status: user.profile?.onboardingStatus ?? 'PHONE_VERIFIED',
    user,
  };
}

/**
 * Mints an access/refresh pair and records the session.
 *
 * The session row is created first so the refresh token can carry its id —
 * that is what lets one device be revoked without touching the others.
 */
async function issueSession(user, { device, ip } = {}) {
  const session = await prisma.userSession.create({
    data: {
      userId: user.id,
      // Replaced immediately below; the row must exist to have an id to sign.
      refreshTokenHash: `pending_${Date.now()}_${Math.random()}`,
      device: device ?? null,
      ip: ip ?? null,
      expiresAt: new Date(Date.now() + refreshTokenTtlMs()),
    },
  });

  const refreshToken = signRefreshToken(user, session.id);
  await prisma.userSession.update({
    where: { id: session.id },
    data: { refreshTokenHash: hashToken(refreshToken) },
  });

  return {
    access_token: signAccessToken(user),
    refresh_token: refreshToken,
    token_type: 'Bearer',
  };
}

/**
 * Trades a refresh token for a new pair.
 *
 * The old token is revoked as part of the swap. Rotating on every refresh
 * means a stolen token is good until its owner next refreshes, rather than for
 * its full thirty days.
 */
async function refresh({ refreshToken, device, ip }) {
  const payload = verifyRefreshToken(refreshToken);

  const session = await prisma.userSession.findUnique({
    where: { id: payload.sid },
    include: { user: { include: USER_INCLUDE } },
  });

  // A valid signature over a revoked session means the token leaked and was
  // already used, or the user logged out. Either way it is not a way in.
  if (!session || session.revokedAt || session.expiresAt < new Date()) {
    throw errors.invalidToken('Please sign in again.');
  }
  if (session.refreshTokenHash !== hashToken(refreshToken)) {
    throw errors.invalidToken('Please sign in again.');
  }

  const user = session.user;
  if (!user || user.deletedAt || user.status === 'deleted') {
    throw errors.invalidToken('This account no longer exists.');
  }
  if (user.status === 'suspended') throw errors.accountSuspended();

  await prisma.userSession.update({
    where: { id: session.id },
    data: { revokedAt: new Date() },
  });

  const tokens = await issueSession(user, { device, ip });
  return { ...tokens, user };
}

/** Ends one session, or every session for the user. */
async function logout({ userId, refreshToken, allDevices = false }) {
  activity.record({
    userId,
    type: 'logout',
    description: allDevices ? 'Signed out of every device' : 'Signed out',
  });

  if (allDevices) {
    const { count } = await prisma.userSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { revoked: count };
  }

  if (refreshToken) {
    const { count } = await prisma.userSession.updateMany({
      where: { userId, refreshTokenHash: hashToken(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { revoked: count };
  }

  // No token supplied — the client discarded it. Revoking everything is the
  // safe reading of "log me out": the alternative leaves a live session the
  // user believes is gone.
  const { count } = await prisma.userSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return { revoked: count };
}

/**
 * Deletes an account, behind a fresh OTP.
 *
 * The `User` row itself is kept, tombstoned, rather than removed — Call
 * history, `Report`s filed by or about this person, and the other side of
 * every `Conversation` reference it, and every one of those relations
 * cascades on the schema. Actually deleting the row would silently take
 * someone else's records with it: the other party's half of a chat thread,
 * their call history, an abuse report they filed that still matters after
 * the account it names is gone.
 *
 * Everything that belongs to this account alone and nobody else — the
 * wallet and its ledger, what it earned, its sessions, its own activity
 * history — is
 * hard-deleted for real, not flagged. What is shared with someone else is
 * anonymised instead of erased: this account's own words are blanked out of
 * every message it sent (the row and the conversation stay, so the other
 * side's thread does not lose messages or renumber), and its profile is
 * wiped to a placeholder rather than deleted outright, because the schema's
 * shared tables key off `User.id` directly and a missing `UserProfile`
 * would be a null a dozen other code paths do not expect.
 */
async function deleteAccount({ user, reason }) {
  const now = new Date();
  const tombstone = `deleted_${user.id}`;

  await prisma.$transaction([
    // Dead the moment they're revoked — nothing keeps a revoked session row
    // around for.
    prisma.userSession.deleteMany({ where: { userId: user.id } }),

    // Money. `Wallet` cascades its own ledger (`WalletTransaction`) with it.
    prisma.wallet.deleteMany({ where: { userId: user.id } }),
    // `Earning` hangs off the *call*, not the wallet, so it needs its own
    // delete — this removes only what this account earned; the `Call` row
    // itself, and the other party's side of it, is untouched.
    prisma.earning.deleteMany({ where: { userId: user.id } }),

    // Their own inbox and history — nobody else's record of anything.
    prisma.notification.deleteMany({ where: { userId: user.id } }),
    prisma.userLanguage.deleteMany({ where: { userId: user.id } }),
    prisma.userActivity.deleteMany({ where: { userId: user.id } }),

    // This account's own words, blanked out of every message it sent —
    // matches the same soft-delete `deleteMessage` already does for one
    // message at a time, just for all of them. The row stays, so a shared
    // thread keeps its shape for whoever it is shared with.
    prisma.message.updateMany({
      where: { senderId: user.id },
      data: {
        deletedAt: now,
        text: '',
        attachmentKind: null,
        attachmentTitle: null,
        attachmentSubtitle: null,
        attachmentUrl: null,
        attachmentDuration: null,
      },
    }),

    prisma.userProfile.update({
      where: { userId: user.id },
      data: {
        name: 'Deleted user',
        bio: '',
        avatarId: null,
        presence: 'offline',
        lastSeen: now,
        isEarner: false,
        isVerified: false,
        verificationStatus: 'not_required',
        verificationRequestedAt: null,
        verifiedAt: null,
        verifiedBy: null,
        rejectionReason: null,
        voiceEnabled: false,
        videoEnabled: false,
      },
    }),
    // Undiscoverable and unreachable, whatever the profile row says.
    prisma.privacySettings.update({
      where: { userId: user.id },
      data: {
        profileVisibleToEveryone: false,
        allowMessages: false,
        allowVoiceCalls: false,
        allowVideoCalls: false,
        showOnlineStatus: false,
      },
    }),
    // Drop the social graph so nobody keeps a live link to the account.
    prisma.friendship.deleteMany({
      where: { OR: [{ userAId: user.id }, { userBId: user.id }] },
    }),
    prisma.friendRequest.deleteMany({
      where: { OR: [{ requesterId: user.id }, { addresseeId: user.id }] },
    }),
    prisma.user.update({
      where: { id: user.id },
      data: {
        status: 'deleted',
        deletedAt: now,
        // Frees the number for a future sign-up while keeping the row unique.
        phone: `${tombstone}_${user.phone}`.slice(0, 64),
      },
    }),
  ]);

  // The one activity record this account keeps — its own history is gone
  // with everything else above, but the deletion event itself is exactly
  // what an administrator reviewing what happened to an account needs to
  // find.
  activity.record({
    userId: user.id,
    type: 'account_deleted',
    description: reason ? `Account deleted — ${reason}` : 'Account deleted',
    metadata: { reason: reason ?? null },
  });

  return { deleted: true };
}

/** Sends the code that authorises a deletion. */
module.exports = {
  requestOtp,
  verifyOtpAndSignIn,
  signInWithFirebase,
  refresh,
  logout,
  deleteAccount,
  issueSession,
  USER_INCLUDE,
};
