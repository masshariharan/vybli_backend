'use strict';

const prisma = require('../config/prisma');
const env = require('../config/env');

/**
 * Disappearing messages. Every message is deleted — for everyone, for good —
 * when its conversation's timer runs out: 24 hours or 7 days, chosen per chat
 * (7 days by default), and never later than `MESSAGE_RETENTION_DAYS` (7)
 * whatever the timer says.
 *
 * **Deleted, not hidden.** The rows go, ciphertext and all, so nothing older
 * than the window exists to be leaked, subpoenaed or decrypted later with a
 * stolen phone key. The app tells people so (profile, privacy settings and
 * the top of every chat); this is what makes that sentence true.
 *
 * Two halves:
 *
 *  * [cutoff] is applied to every read, so a message past the window is never
 *    shown even in the minutes before the sweep reaches it.
 *  * [purgeExpiredMessages] runs hourly from `server.js` and removes the rows.
 *
 * Conversations themselves are kept — they hold the pair, pins and mutes, and
 * a thread that has gone quiet for a week is still a thread. Only its
 * messages age out. What is *not* removed: evidence a reporter attached to a
 * `Report`. That is a safety record the reporter handed over deliberately,
 * reviewed on its own schedule, and deleting it would let anyone who waits
 * seven days erase the case against them.
 */

/** The oldest moment a message may have been sent and still exist. */
function cutoff(now = new Date()) {
  return new Date(now.getTime() - env.chat.retentionDays * 86_400_000);
}

/** The timers a chat can be set to, in hours: 24 hours or 7 days. */
const TIMER_CHOICES = [24, 168];
const DEFAULT_TIMER_HOURS = 168;

/**
 * When a message sent now, in a chat with [ttlHours], expires. Capped at the
 * retention ceiling, so no setting can keep a message longer than that.
 */
function expiryFor(ttlHours, now = new Date()) {
  const hours = Math.min(ttlHours ?? DEFAULT_TIMER_HOURS, env.chat.retentionDays * 24);
  return new Date(now.getTime() + hours * 3_600_000);
}

/**
 * The Prisma condition for "still exists as far as anyone may see": inside
 * the ceiling, and its own timer not run out. Every read of messages ANDs
 * this in, so nothing is shown in the gap before the purge reaches it.
 */
function visibleWhere(now = new Date()) {
  return {
    createdAt: { gt: cutoff(now) },
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  };
}

/** Rows removed per statement, so a large backlog never holds one long lock. */
const BATCH = 5_000;

/**
 * Deletes every message older than the window, and the notifications that
 * announced them, then corrects the unread counters of the conversations it
 * touched — a badge must not go on counting messages that no longer exist.
 *
 * Safe to run at any time and from more than one process: each batch deletes
 * whatever is still there, and the counters are recomputed from the rows that
 * remain rather than adjusted by what this run happened to delete.
 *
 * @returns {{ messages: number, notifications: number, conversations: number }}
 */
async function purgeExpiredMessages(now = new Date()) {
  const before = cutoff(now);
  const touched = new Set();
  let messages = 0;

  for (;;) {
    const rows = await prisma.$queryRaw`
      DELETE FROM "messages"
      WHERE "id" IN (
        SELECT "id" FROM "messages"
        WHERE "createdAt" < ${before} OR "expiresAt" <= ${now}
        LIMIT ${BATCH}
      )
      RETURNING "conversationId"`;
    for (const r of rows) touched.add(r.conversationId);
    messages += rows.length;
    if (rows.length < BATCH) break;
  }

  if (touched.size > 0) {
    // Unread = the peer's messages still unread, after this side's own
    // delete-for-me cut-off (which already zeroed what came before it).
    const ids = [...touched];
    await prisma.$executeRaw`
      UPDATE "conversations" AS c SET
        "unreadForA" = (
          SELECT COUNT(*)::int FROM "messages" m
          WHERE m."conversationId" = c."id" AND m."senderId" = c."userBId"
            AND m."readAt" IS NULL AND m."deletedAt" IS NULL
            AND m."createdAt" > COALESCE(c."deletedAtByA", '-infinity'::timestamp)
        ),
        "unreadForB" = (
          SELECT COUNT(*)::int FROM "messages" m
          WHERE m."conversationId" = c."id" AND m."senderId" = c."userAId"
            AND m."readAt" IS NULL AND m."deletedAt" IS NULL
            AND m."createdAt" > COALESCE(c."deletedAtByB", '-infinity'::timestamp)
        )
      WHERE c."id" = ANY(${ids}::text[])`;
  }

  // The "new message" notifications for those messages. From an out-of-date
  // app their body is the message text itself, so they age out with it — at
  // the ceiling, or sooner when the message they announce is already gone.
  const notifications = await prisma.$executeRaw`
    DELETE FROM "notifications" n
    WHERE n."kind" = 'message'
      AND (
        n."createdAt" < ${before}
        OR (
          n."data" ? 'message_id'
          AND NOT EXISTS (SELECT 1 FROM "messages" m WHERE m."id" = n."data"->>'message_id')
        )
      )`;

  return { messages, notifications, conversations: touched.size };
}

module.exports = {
  cutoff,
  expiryFor,
  visibleWhere,
  purgeExpiredMessages,
  TIMER_CHOICES,
  DEFAULT_TIMER_HOURS,
};
