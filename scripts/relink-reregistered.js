'use strict';

/**
 * One-off repair: carries deleted accounts' chats over to the accounts that
 * re-registered on the same phone number, for sign-ups that happened while
 * that was not running — and removes the empty duplicate chats that left
 * behind.
 *
 *   node scripts/relink-reregistered.js            # dry run: report only
 *   node scripts/relink-reregistered.js --apply    # make the changes
 *
 * The symptom: the other person sees the same number twice in their Chats
 * list — the old thread with the history, still on the deleted account, and
 * a second, empty one ("Say hello") with the new account. After this:
 *
 *  * the old thread continues with the new account (its live name and photo),
 *    history intact, and the empty duplicate is gone;
 *  * the new account still sees none of the old messages — its side of the
 *    carried-over thread is marked deleted as of now;
 *  * where the duplicate already holds messages someone wrote, both threads
 *    are left as they are: messages cannot move between threads (their
 *    encryption is bound to the thread), so merging would destroy one side's
 *    history. Those are listed for a person to look at.
 *
 * Safe to run more than once: a thread already carried over is not found
 * again, because it no longer belongs to the deleted account.
 */

const prisma = require('../src/config/prisma');
const relationship = require('../src/services/relationship.service');

const apply = process.argv.includes('--apply');

async function main() {
  // Live accounts whose phone number a deleted account once held, and which
  // still has threads on the deleted account.
  const candidates = await prisma.$queryRaw`
    SELECT DISTINCT u.id, u."dialCode", u.phone
    FROM users u
    JOIN users d
      ON d.status = 'deleted'
     AND d."dialCode" = u."dialCode"
     AND d.phone LIKE '%\\_' || u.phone ESCAPE '\\'
     AND d.id <> u.id
    JOIN conversations c ON c."userAId" = d.id OR c."userBId" = d.id
    WHERE u.status <> 'deleted' AND u."deletedAt" IS NULL
  `;

  const totals = {};
  for (const user of candidates) {
    if (apply) {
      const outcomes = await relationship.relinkConversationsForPhone(user);
      for (const outcome of outcomes) totals[outcome] = (totals[outcome] ?? 0) + 1;
      console.log(`user ${user.id}: ${outcomes.join(', ') || 'nothing to do'}`);
      continue;
    }

    // Dry run: say what would happen to each thread, without touching it.
    const olds = await prisma.user.findMany({
      where: {
        status: 'deleted',
        dialCode: user.dialCode,
        phone: { endsWith: `_${user.phone}` },
        id: { not: user.id },
      },
      select: { id: true },
    });
    for (const old of olds) {
      const threads = await prisma.conversation.findMany({
        where: { OR: [{ userAId: old.id }, { userBId: old.id }] },
      });
      for (const thread of threads) {
        const peerId = thread.userAId === old.id ? thread.userBId : thread.userAId;
        const [a, b] = relationship.orderPair(peerId, user.id);
        const duplicate = await prisma.conversation.findUnique({
          where: { userAId_userBId: { userAId: a, userBId: b } },
        });
        let outcome = 'relinked';
        if (duplicate) {
          const written = await prisma.message.count({
            where: { conversationId: duplicate.id, event: null },
          });
          outcome = written > 0 ? 'kept-both' : 'replaced-empty-duplicate';
        }
        totals[outcome] = (totals[outcome] ?? 0) + 1;
        console.log(`would ${outcome}: thread ${thread.id} (peer ${peerId}) → user ${user.id}`);
      }
    }
  }

  console.log('');
  for (const [outcome, count] of Object.entries(totals)) {
    console.log(`${outcome}: ${count}`);
  }
  if (Object.keys(totals).length === 0) console.log('nothing to repair');
  if (!apply && Object.keys(totals).length > 0) {
    console.log('\nrun with --apply to make these changes');
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
