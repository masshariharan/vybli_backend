'use strict';

const prisma = require('../config/prisma');
const { emitToAdmin } = require('../sockets/bus');

/**
 * Disconnected calls — the live calls somebody else ended on a woman.
 *
 * A call counts when it was **connected** and the **other person** ended it:
 * he hung up, or his connection dropped. It does not count when she ended it
 * herself, when it ran out of balance (nobody chose that), or when the server
 * closed it during a sweep and so cannot say whose side went.
 *
 * **About women only.** A row is written only when the person left on the
 * call is a woman — they are the ones who earn from calls, so they are the
 * ones a cut call costs.
 *
 * **For the admin panel only.** Nothing here is ever sent to an app: this
 * module only writes, and the reads live in `admin/disconnects.service`
 * behind the admin router. The one event it raises goes to the admin feed.
 *
 * **Its own table** (`CallDisconnect`), not a query over `Call`: clearing call
 * history hard-deletes those rows, and this must outlive either side tidying
 * a call log. `callId` is unique, so a duplicated end event writes nothing
 * the second time.
 *
 * **Never in the way of a call.** [record] runs in the background
 * bookkeeping after `call:ended` has already gone out, and its caller logs
 * a failure rather than raising it.
 */

/** The only endings that are somebody disconnecting. */
const REASONS = new Set(['hungUp', 'networkError']);

/** A call ended sooner than this is a "quick" disconnect. */
const QUICK_SECONDS = 60;

/** This many disconnects in the period marks someone as frequent. */
const FREQUENT_AT = 3;

/**
 * Notes a finished call as a disconnect, if it was one. Idempotent.
 *
 * [call] is the finished row with both people loaded; [endedById] is whoever
 * ended it, or null when nobody in particular did.
 *
 * Returns true when a row was written.
 */
async function record({ call, endedById, reason }) {
  if (!call || call.status !== 'ended' || !call.connectedAt) return false;
  if (!REASONS.has(reason)) return false;
  if (!endedById) return false;
  if (endedById !== call.callerId && endedById !== call.calleeId) return false;

  const left = endedById === call.callerId ? call.callee : call.caller;
  const leftId = endedById === call.callerId ? call.calleeId : call.callerId;
  if (left?.profile?.gender !== 'female') return false;

  const durationSeconds = Math.max(0, Number(call.durationSeconds) || 0);
  const { count } = await prisma.callDisconnect.createMany({
    data: [
      {
        callId: call.id,
        userId: leftId,
        byUserId: endedById,
        type: call.type,
        reason,
        durationSeconds,
        createdAt: call.endedAt ?? new Date(),
      },
    ],
    skipDuplicates: true,
  });
  if (count === 0) return false;

  // The admin panel's Disconnected calls page refreshes on this.
  emitToAdmin('admin:call_disconnected', {
    call_id: call.id,
    by_user_id: endedById,
    user_id: leftId,
    type: call.type,
    reason,
    duration_seconds: durationSeconds,
  });
  return true;
}

module.exports = { record, REASONS, QUICK_SECONDS, FREQUENT_AT };
