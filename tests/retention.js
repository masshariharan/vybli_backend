'use strict';

/**
 * Seven-day message retention, against a running server.
 *
 *   node src/server.js        # terminal one
 *   npm run test:retention    # terminal two
 *
 * Messages are backdated in the database rather than waited for, then the
 * purge is run in this process — the same function the server runs hourly.
 */

const {
  check,
  section,
  get,
  post,
  createAccount,
  withPrisma,
  cleanup,
  summary,
  fail,
  BASE,
} = require('./lib/client');
const retention = require('../src/services/retention.service');

const DAY = 86_400_000;

async function run() {
  console.log(`Vybli message retention — ${BASE}\n`);

  const payer = await createAccount({ name: 'Retention Payer', gender: 'male' });
  const earner = await createAccount({ name: 'Retention Earner', gender: 'female' });
  const opened = await post(`/users/${earner.id}/conversation`, payer.token);
  const conversationId = opened.data?.thread?.id;

  const send = async (text) =>
    (await post(`/conversations/${conversationId}/messages`, payer.token, { text })).data
      ?.message?.id;
  const oldId = await send('eight days old');
  const edgeId = await send('six days old');
  const newId = await send('just now');

  // Backdate two of them, and their notifications with them.
  await withPrisma(async (prisma) => {
    await prisma.message.update({
      where: { id: oldId },
      data: { createdAt: new Date(Date.now() - 8 * DAY) },
    });
    await prisma.message.update({
      where: { id: edgeId },
      data: { createdAt: new Date(Date.now() - 6 * DAY) },
    });
    await prisma.notification.updateMany({
      where: { userId: earner.id, kind: 'message' },
      data: { createdAt: new Date(Date.now() - 8 * DAY) },
    });
  });

  section('Before the purge runs');

  const listed = await get(`/conversations/${conversationId}`, earner.token);
  const shown = listed.data?.thread?.messages?.map((m) => m.id) ?? [];
  check('a message past 7 days is not shown, even before it is deleted', !shown.includes(oldId), shown);
  check('messages inside the window are', shown.includes(edgeId) && shown.includes(newId), shown);

  section('The purge');

  // Unread again, so the recount has something to get right.
  await withPrisma((prisma) =>
    prisma.message.updateMany({
      where: { conversationId },
      data: { readAt: null, status: 'sent' },
    })
  );
  const result = await retention.purgeExpiredMessages();
  check('it deletes what is past the window', result.messages >= 1, result);

  const rows = await withPrisma((prisma) =>
    prisma.message.findMany({ where: { conversationId }, select: { id: true } })
  );
  const left = rows.map((r) => r.id);
  check('the old message is gone from the database', !left.includes(oldId), left);
  check('the recent ones are kept', left.includes(edgeId) && left.includes(newId), left);

  const conversation = await withPrisma((prisma) =>
    prisma.conversation.findUnique({ where: { id: conversationId } })
  );
  const earnerUnread =
    conversation.userAId === earner.id ? conversation.unreadForA : conversation.unreadForB;
  check('the unread count no longer counts the deleted message', earnerUnread === 2, {
    earnerUnread,
  });

  const notifications = await withPrisma((prisma) =>
    prisma.notification.count({ where: { userId: earner.id, kind: 'message' } })
  );
  check('and its notifications went with it', notifications === 0, { notifications });

  const again = await retention.purgeExpiredMessages();
  check('running it again deletes nothing more', again.messages === 0, again);
}

run()
  .catch((err) => fail(`\nCrashed: ${err.stack ?? err}`))
  .finally(async () => {
    try {
      await cleanup();
    } catch (err) {
      console.error('cleanup failed', err);
    }
    const { passed, failed } = summary();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
