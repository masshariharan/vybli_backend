'use strict';

const prisma = require('../config/prisma');

/**
 * The record of what happened.
 *
 * Written by the services, at the moment the operation actually completes —
 * never from a client event. A timeline assembled from what the app chose to
 * report would be missing exactly the entries that matter: the ones from a
 * handset that crashed, was offline, or was lying about what it did.
 *
 * Two rules govern everything here:
 *
 * 1. **Recording must never break the operation.** A call is placed, money
 *    moves, a message is delivered — and then this runs. If it throws, the
 *    thing that already happened must still count. Every write is therefore
 *    fire-and-forget with the failure logged, not propagated.
 *
 * 2. **The description is composed at write time.** The admin timeline renders
 *    a mixed feed of thirty-odd activity types; making the UI reconstruct a
 *    sentence from a type and a metadata blob would put product copy in the
 *    frontend and leave old rows unreadable after a rename.
 */

/**
 * Records one activity.
 *
 * Deliberately not awaited by callers — see rule 1 above. Returns the promise
 * anyway, so a test can wait for it.
 */
function record({
  userId,
  type,
  relatedUserId = null,
  relatedEntityId = null,
  description,
  metadata = null,
  status = null,
}) {
  if (!userId || !type) return Promise.resolve(null);

  return prisma.userActivity
    .create({
      data: {
        userId,
        type,
        relatedUserId,
        relatedEntityId,
        description,
        metadata: metadata ?? undefined,
        status,
      },
    })
    .catch((err) => {
      // Swallowed on purpose. The operation this describes has already
      // happened and committed; failing it now would be strictly worse than
      // a gap in the timeline.
      console.error(`[activity] could not record ${type} for ${userId}:`, err.message);
      return null;
    });
}

/**
 * Records the same event for both sides of an interaction.
 *
 * A friend request is one action but two histories: it appears as "sent to X"
 * on one timeline and "received from Y" on the other. Recording only the
 * actor's half leaves the other account's history with holes exactly where
 * somebody did something to them.
 */
function recordPair(actor, subject) {
  return Promise.all([record(actor), record(subject)]);
}

/** A person's name for a description, without a second query where possible. */
function nameOf(user) {
  return user?.profile?.name || user?.name || 'someone';
}

module.exports = { record, recordPair, nameOf };
