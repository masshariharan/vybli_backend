'use strict';

const prisma = require('../config/prisma');
const { errors, AppError } = require('../utils/errors');
const storage = require('./storage.service');
const onboardingService = require('./onboarding.service');
const notificationService = require('./notification.service');
const activity = require('./activity.service');
const { emitToAdmin } = require('../sockets/bus');

/**
 * The voice check that gates the Earn Money role.
 *
 * **A person decides this, not this file.** A submission of usable length is
 * recorded `pending` and appears in the admin panel's review queue, where
 * `platform.decideVerification` is what actually sets `isVerified`. That is
 * the only path to a verified profile.
 *
 * It used to approve automatically on sample length alone. That made
 * `isVerified` — the flag deciding who is discoverable and who may take paid
 * calls — mean nothing more than "held the button for four seconds", while the
 * review queue the administrator was given sat unused.
 *
 * The length floor stays, as *validation* rather than a verdict: a two-second
 * clip is not a sample a reviewer could form an opinion about, and rejecting
 * it immediately is a better answer than a queue entry nobody can action.
 *
 * This also used to accept only a self-reported language and length — no
 * actual recording ever reached the server, so a reviewer had metadata and
 * nothing to listen to. It now requires and stores a real clip via
 * `storage.service`.
 *
 * Samples and outcomes are private. Only the resulting `isVerified` flag ever
 * appears on a public profile.
 */

const MIN_SAMPLE_SECONDS = 4;

/**
 * What to record for this submission.
 *
 * Two outcomes: too short to review, or queued for review. There is
 * deliberately no branch that approves.
 */
function triage({ durationSeconds }) {
  if (durationSeconds < MIN_SAMPLE_SECONDS) {
    return {
      status: 'rejected',
      reason:
        'The recording was too short. Find a quiet spot and speak for at least 5 seconds.',
      reviewedBy: 'system',
      reviewNotes: `Rejected without review — under the ${MIN_SAMPLE_SECONDS}s minimum.`,
    };
  }
  return { status: 'pending', reason: null, reviewedBy: null, reviewNotes: null };
}

/**
 * Submits a sample for review.
 *
 * Returns what happened to the *submission*, not whether the account is now
 * verified — nothing here can make it verified. The client shows "under
 * review" and learns the outcome the way it learns anything else the server
 * decided later: a notification, or the next session refresh.
 *
 * A rejection is recorded too. Repeated failures are the signal a reviewer
 * would want, and discarding them would erase it.
 */
async function submit(user, { languageCode, durationSeconds, audioBuffer }) {
  if (!user.profile?.isEarner) {
    throw errors.badRequest(
      'Voice verification is only needed for Earn Money accounts.',
      { code: 'NOT_EARNER_ACCOUNT' }
    );
  }

  if (!audioBuffer || audioBuffer.length === 0) {
    throw errors.badRequest('Attach a recording as the "audio" field.');
  }

  if (languageCode) {
    const language = await prisma.language.findUnique({ where: { code: languageCode } });
    if (!language) throw errors.notFound('Language', 'LANGUAGE_NOT_FOUND');
  }

  const outcome = triage({ durationSeconds });

  // A clip too short to review is never stored — there is nothing in it a
  // reviewer could form an opinion about, so paying to keep it buys nothing.
  // Only a clip going to the queue is worth the storage cost.
  let sampleUrl = null;
  if (outcome.status !== 'rejected') {
    try {
      const stored = await storage.putVerification(user.id, audioBuffer);
      sampleUrl = stored.url;
    } catch (error) {
      if (!(error instanceof storage.StorageError)) throw error;
      if (error.code === 'unavailable' || error.code === 'not_configured') {
        throw new AppError(error.message, { status: 503, code: 'STORAGE_UNAVAILABLE' });
      }
      throw errors.badRequest(error.message);
    }
  }

  // Which try this is. Counted across every kind rather than filtered to
  // `voice` — an account's attempt history from before this carried a real
  // recording is still its history, and starting the count over would
  // understate a repeat offender to the reviewer who relies on this number.
  const attempt = (await prisma.verification.count({ where: { userId: user.id } })) + 1;

  const verification = await prisma.verification.create({
    data: {
      userId: user.id,
      kind: 'voice',
      status: outcome.status,
      languageCode: languageCode ?? null,
      sampleUrl,
      durationSeconds,
      rejectionReason: outcome.reason,
      // Null while it waits. `reviewedAt` is when somebody looked, and
      // stamping it on arrival would make an unreviewed row indistinguishable
      // from a reviewed one in the queue's own sorting.
      reviewedAt: outcome.status === 'pending' ? null : new Date(),
      attempt,
      reviewedBy: outcome.reviewedBy,
      reviewNotes: outcome.reviewNotes,
    },
  });

  activity.record({
    userId: user.id,
    type: 'verification_requested',
    relatedEntityId: verification.id,
    description: `Submitted a voice sample for verification (attempt ${attempt})`,
    metadata: {
      attempt,
      language_code: languageCode ?? null,
      duration_seconds: durationSeconds,
    },
    status: outcome.status,
  });

  emitToAdmin('admin:verification_submitted', {
    verification_id: verification.id,
    user_id: user.id,
    name: user.profile?.name ?? null,
    status: outcome.status,
    attempt,
    at: verification.createdAt.toISOString(),
  });

  if (outcome.status === 'rejected') {
    activity.record({
      userId: user.id,
      type: 'verification_rejected',
      relatedEntityId: verification.id,
      description: `Voice verification was not accepted — ${outcome.reason}`,
      metadata: { attempt, reason: outcome.reason },
      status: 'rejected',
    });
    return { verification, status: 'rejected', user };
  }

  // Onboarding advances on *submission*, not on approval.
  //
  // The alternative strands the account: this is the last onboarding step, so
  // leaving it incomplete until a reviewer gets to it locks the user out of
  // every route past onboarding for as long as the queue is. Being
  // discoverable and taking paid calls is gated on `isVerified`, which is a
  // separate flag and is still false.
  await prisma.userProfile.update({
    where: { userId: user.id },
    data: {
      onboardingStatus: onboardingService.advance(
        user.profile.onboardingStatus,
        'VERIFICATION_COMPLETED'
      ),
    },
  });

  await notificationService.notify({
    userId: user.id,
    kind: 'system',
    title: 'Voice sample received',
    body: 'Our team is reviewing it. You will hear from us shortly.',
    data: { verification_id: verification.id },
  });

  const fresh = await prisma.user.findUnique({
    where: { id: user.id },
    include: {
      profile: { include: { city: true } },
      privacySettings: true,
      languages: { include: { language: true } },
    },
  });

  return { verification, status: 'pending', user: fresh };
}

/** The latest attempt, plus whether the account is verified. */
async function status(user) {
  const latest = await prisma.verification.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
  });

  return {
    is_verified: user.profile?.isVerified ?? false,
    requires_verification: Boolean(user.profile?.isEarner),
    latest: latest ?? null,
    min_sample_seconds: MIN_SAMPLE_SECONDS,
  };
}

/** Every attempt, so repeated failures are visible to the user too. */
async function history(user, { skip, take }) {
  const where = { userId: user.id };
  const [rows, total] = await Promise.all([
    prisma.verification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.verification.count({ where }),
  ]);
  return { rows, total };
}

module.exports = { submit, status, history, MIN_SAMPLE_SECONDS };
