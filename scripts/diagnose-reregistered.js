'use strict';
/**
 * READ-ONLY: why a chat with a deleted account has not moved to the account
 * that re-registered on the same number.
 *
 *   railway run node scripts/diagnose-reregistered.js [name]
 *
 * (`railway run` supplies the production DATABASE_URL.) Only reads — nothing
 * is written. Phone numbers are masked. [name] narrows to profiles whose name
 * contains it (default "aran").
 */
const prisma = require('../src/config/prisma');

const nameLike = process.argv[2] ?? 'aran';

const mask = (p) => {
  if (!p) return p;
  const m = p.match(/^deleted_([^_]+)_(.*)$/);
  if (m) return `deleted_<${m[1].slice(0, 6)}…>_${'x'.repeat(Math.max(0, m[2].length - 2))}${m[2].slice(-2)} (number length ${m[2].length})`;
  return `${'x'.repeat(Math.max(0, p.length - 2))}${p.slice(-2)} (length ${p.length})`;
};

async function main() {
  const people = await prisma.user.findMany({
    where: { profile: { name: { contains: nameLike, mode: 'insensitive' } } },
    select: {
      id: true, status: true, deletedAt: true, dialCode: true, phone: true, createdAt: true,
      profile: { select: { name: true, onboardingStatus: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  console.log('\nAccounts named like "…aran":');
  for (const u of people) {
    console.log(`  ${u.id.slice(0, 8)}  ${u.profile?.name.padEnd(12)} status=${u.status} deletedAt=${u.deletedAt ? 'yes' : 'no'} ` +
      `onboarding=${u.profile?.onboardingStatus} dial=${u.dialCode} phone=${mask(u.phone)} created=${u.createdAt.toISOString()}`);
  }

  const deleted = people.filter((u) => u.status === 'deleted');
  for (const old of deleted) {
    const convos = await prisma.conversation.findMany({
      where: { OR: [{ userAId: old.id }, { userBId: old.id }] },
      select: { id: true, userAId: true, userBId: true, lastMessageAt: true },
    });
    const prefix = `deleted_${old.id}_`;
    const original = old.phone.startsWith(prefix) ? old.phone.slice(prefix.length) : null;
    const successor = original
      ? await prisma.user.findFirst({
          where: { dialCode: old.dialCode, phone: original, status: { not: 'deleted' }, deletedAt: null },
          select: { id: true, profile: { select: { name: true, onboardingStatus: true } } },
        })
      : null;
    console.log(`\nDeleted ${old.id.slice(0, 8)} (${old.profile?.name}):`);
    console.log(`  phone matches tombstone format: ${Boolean(original)}`);
    console.log(`  live account on same number: ${successor ? `${successor.id.slice(0, 8)} ${successor.profile?.name} (${successor.profile?.onboardingStatus})` : 'none'}`);
    console.log(`  chats still on this deleted account: ${convos.length}`);
    for (const c of convos) {
      const peerId = c.userAId === old.id ? c.userBId : c.userAId;
      const peer = await prisma.user.findUnique({ where: { id: peerId }, select: { profile: { select: { name: true } }, status: true } });
      const dupe = successor
        ? await prisma.conversation.findFirst({
            where: { OR: [{ userAId: peerId, userBId: successor.id }, { userAId: successor.id, userBId: peerId }] },
            select: { id: true },
          })
        : null;
      const written = dupe ? await prisma.message.count({ where: { conversationId: dupe.id, event: null } }) : 0;
      console.log(`    chat ${c.id.slice(0, 8)} with ${peer?.profile?.name} (${peer?.status}); ` +
        `duplicate with new account: ${dupe ? `yes, ${written} written message(s)` : 'no'}`);
    }
  }
}

main()
  .catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
