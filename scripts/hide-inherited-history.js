'use strict';

/**
 * One-off repair for conversations carried over to a re-registered account
 * *before* the new account's side was hidden.
 *
 *   node scripts/hide-inherited-history.js            # dry run: report only
 *   node scripts/hide-inherited-history.js --apply    # make the changes
 *
 * When an account is deleted and someone signs up again on the same phone
 * number, `relinkConversationsForPhone` hands the deleted account's threads
 * to the new account so the *other* person's chat continues. It now also
 * marks the new account's side deleted-for-me, so the new account starts with
 * none of that history. Threads re-pointed before that change are missing the
 * mark: the new account still lists them and shows the deleted account's
 * messages, which it holds no key for — "can't be decrypted".
 *
 * A thread needs the mark when one of its two members is a newer account
 * than some message in it from a sender who is not a member any more — that
 * is, it was carried over to that member. Their side is marked deleted as of
 * the moment their account was created: everything from before they existed
 * disappears for them, anything since (a reply, a new message) stays. The
 * other person's side is not touched.
 *
 * Safe to run more than once: a side already deleted at or after the cutoff
 * is left alone.
 */

const prisma = require('../src/config/prisma');

const apply = process.argv.includes('--apply');

async function main() {
  // Every thread with at least one message from someone who is no longer one
  // of its two members.
  const candidates = await prisma.$queryRaw`
    SELECT DISTINCT c.id
    FROM conversations c
    JOIN messages m ON m."conversationId" = c.id
    WHERE m."senderId" <> c."userAId" AND m."senderId" <> c."userBId"
  `;

  let fixed = 0;
  for (const { id } of candidates) {
    const conversation = await prisma.conversation.findUnique({
      where: { id },
      include: {
        userA: { select: { id: true, createdAt: true } },
        userB: { select: { id: true, createdAt: true } },
      },
    });
    if (!conversation) continue;

    for (const side of ['A', 'B']) {
      const member = side === 'A' ? conversation.userA : conversation.userB;
      // A message from a former member, sent before this member existed:
      // this member inherited the thread.
      const inherited = await prisma.message.findFirst({
        where: {
          conversationId: id,
          senderId: { notIn: [conversation.userAId, conversation.userBId] },
          createdAt: { lt: member.createdAt },
        },
        select: { id: true },
      });
      if (!inherited) continue;

      const deletedField = side === 'A' ? 'deletedAtByA' : 'deletedAtByB';
      const current = conversation[deletedField];
      if (current && current >= member.createdAt) continue;

      fixed++;
      console.log(
        `${apply ? 'hiding' : 'would hide'} inherited history: conversation ${id}, ` +
          `member ${member.id} (account created ${member.createdAt.toISOString()})`
      );
      if (apply) {
        await prisma.conversation.update({
          where: { id },
          data: {
            [deletedField]: member.createdAt,
            [side === 'A' ? 'unreadForA' : 'unreadForB']: 0,
            [side === 'A' ? 'pinnedByA' : 'pinnedByB']: false,
          },
        });
      }
    }
  }

  console.log(
    `\n${fixed} conversation side${fixed === 1 ? '' : 's'} ` +
      `${apply ? 'hidden' : 'to hide'}${apply ? '' : ' — run with --apply to make the change'}`
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
