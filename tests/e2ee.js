'use strict';

/**
 * End-to-end encrypted chat, against a running server.
 *
 *   node src/server.js        # terminal one
 *   npm run test:e2ee         # terminal two
 *
 * Both test accounts are real clients here: they hold X25519 keys the server
 * never sees, encrypt with the reference implementation in
 * `lib/e2ee-reference.js`, and decrypt what comes back. What this proves is
 * the part only the server can get wrong — that it stores and relays the
 * envelope untouched, keeps no readable copy anywhere (the message row, the
 * notification, the push body), refuses an envelope encrypted for the wrong
 * set of devices, and scopes the key directory to conversation members.
 */

const crypto = require('node:crypto');
const ref = require('./lib/e2ee-reference');

const {
  check,
  section,
  get,
  post,
  put,
  del,
  createAccount,
  online,
  nextEvent,
  withPrisma,
  cleanup,
  summary,
  fail,
  BASE,
} = require('./lib/client');

const register = (account, device) =>
  put(`/e2ee/devices/${device.deviceId}`, account.token, {
    public_key: ref.b64(device.publicKey),
    platform: 'android',
  });

/** The active devices of a conversation, as `encrypt` wants them. */
async function recipientsOf(conversationId, token) {
  const res = await get(`/conversations/${conversationId}/keys`, token);
  return (res.data?.devices ?? [])
    .filter((d) => d.active)
    .map((d) => ({ userId: d.user_id, deviceId: d.device_id, publicKey: ref.unb64(d.public_key) }));
}

async function run() {
  console.log(`Vybli end-to-end encryption — ${BASE}\n`);

  const payer = await createAccount({ name: 'E2EE Payer', gender: 'male' });
  const earner = await createAccount({ name: 'E2EE Earner', gender: 'female' });
  const a1 = ref.newDevice();
  const b1 = ref.newDevice();

  // ── The key directory ────────────────────────────────────────────────────
  section('Device keys');

  const regA = await register(payer, a1);
  check('a device registers its public key', regA.success && regA.data.device.active, regA);
  const regB = await register(earner, b1);
  check('so does the other person’s', regB.success, regB);
  const again = await register(payer, a1);
  check('re-registering the same key is idempotent', again.success, again);

  const swapped = await put(`/e2ee/devices/${a1.deviceId}`, payer.token, {
    public_key: ref.b64(ref.newDevice().publicKey),
  });
  check(
    'the same device id with a different key is refused, not overwritten',
    swapped.status === 409 && swapped.error === 'E2EE_DEVICE_KEY_MISMATCH',
    swapped
  );

  const junk = await put(`/e2ee/devices/${a1.deviceId}x`, payer.token, { public_key: 'not-a-key' });
  check('a malformed public key is rejected', junk.status === 422 || junk.status === 400, junk);

  const noAuth = await put(`/e2ee/devices/${a1.deviceId}`, null, { public_key: ref.b64(a1.publicKey) });
  check('registering needs a sign-in', noAuth.status === 401, noAuth);

  const opened = await post(`/users/${earner.id}/conversation`, payer.token);
  const conversationId = opened.data?.thread?.id;
  check('the payer opens a conversation with the earner', Boolean(conversationId), opened);

  const keys = await get(`/conversations/${conversationId}/keys`, payer.token);
  const listed = keys.data?.devices?.map((d) => d.device_id) ?? [];
  check(
    'the conversation’s key list holds both people’s devices',
    listed.includes(a1.deviceId) && listed.includes(b1.deviceId),
    keys
  );
  check(
    'and nothing but public keys',
    keys.data?.devices?.every((d) => Object.keys(d).every((k) => !/private|secret/i.test(k)))
  );

  const outsider = await createAccount({ name: 'E2EE Outsider', gender: 'male' });
  const snoop = await get(`/conversations/${conversationId}/keys`, outsider.token);
  check('someone outside the conversation cannot read its key list', snoop.status === 404, snoop);

  const looked = await post('/e2ee/devices/lookup', payer.token, {
    user_ids: [earner.id, outsider.id],
  });
  const lookedUsers = new Set(looked.data?.devices?.map((d) => d.user_id));
  check(
    'a batch lookup returns contacts’ keys and no one else’s',
    lookedUsers.has(earner.id) && !lookedUsers.has(outsider.id),
    looked
  );

  // ── Sending ──────────────────────────────────────────────────────────────
  section('Sending an encrypted message');

  const secret = `meet me at 7 — ${crypto.randomBytes(4).toString('hex')}`;
  const envelope = ref.encrypt({
    conversationId,
    senderUserId: payer.id,
    sender: a1,
    recipients: await recipientsOf(conversationId, payer.token),
    text: secret,
  });

  const earnerSocket = await online(earner);
  const incoming = nextEvent(earnerSocket, 'message:new');
  const sent = await post(`/conversations/${conversationId}/messages`, payer.token, {
    envelope,
    client_id: 'e2ee_1',
    // Ignored for an encrypted send — nothing readable is stored beside it.
    text: 'this plaintext must never be stored',
  });
  check('the encrypted message is accepted', sent.status === 201, sent);
  const messageId = sent.data?.message?.id;

  const live = await incoming;
  check('the recipient’s socket receives the envelope', Boolean(live?.message?.envelope), live);
  check('with the sender’s user id, needed to decrypt', live?.message?.sender_id === payer.id);
  const liveText = live?.message?.envelope
    ? ref.decrypt({
        envelope: live.message.envelope,
        conversationId,
        senderUserId: payer.id,
        senderPublicKey: a1.publicKey,
        reader: { userId: earner.id, device: b1 },
      }).text
    : null;
  check('which the recipient’s device decrypts to what was written', liveText === secret, liveText);
  check(
    'an out-of-date app sees an explanation, not the message',
    live?.message?.text?.includes('Encrypted message'),
    live?.message?.text
  );

  const selfText = ref.decrypt({
    envelope: sent.data.message.envelope,
    conversationId,
    senderUserId: payer.id,
    senderPublicKey: a1.publicKey,
    reader: { userId: payer.id, device: a1 },
  }).text;
  check('the sender’s own device can re-read it later', selfText === secret);

  const thread = await get(`/conversations/${conversationId}`, earner.token);
  const stored = thread.data?.thread?.messages?.find((m) => m.id === messageId);
  // Compared field by field: JSONB stores an object's keys in its own order.
  const canonical = (e) =>
    e && JSON.stringify([e.v, e.sender_device, e.epk, e.iv, e.ct, e.keys.map((k) => [k.user, k.device, k.iv, k.wk])]);
  check('history returns the envelope as sent', canonical(stored?.envelope) === canonical(envelope), stored);

  const row = await withPrisma((prisma) => prisma.message.findUnique({ where: { id: messageId } }));
  check('the stored row has no readable text', row?.text === '', row?.text);
  check(
    'and nothing in it contains the message',
    !JSON.stringify(row).includes(secret) && !JSON.stringify(row).includes('must never be stored')
  );

  const notifications = await withPrisma((prisma) =>
    prisma.notification.findMany({ where: { userId: earner.id }, orderBy: { createdAt: 'desc' } })
  );
  check(
    'the recipient’s notification says only that a message arrived',
    notifications[0]?.body === 'Sent you a message' && !JSON.stringify(notifications).includes(secret),
    notifications[0]
  );

  const retried = await post(`/conversations/${conversationId}/messages`, payer.token, {
    envelope,
    client_id: 'e2ee_1',
  });
  check('a retry with the same client id returns the same message', retried.data?.message?.id === messageId);

  // ── What the server refuses ──────────────────────────────────────────────
  section('Refusals');

  const a2 = ref.newDevice();
  await register(payer, a2);
  const stale = await post(`/conversations/${conversationId}/messages`, payer.token, {
    envelope: ref.encrypt({
      conversationId,
      senderUserId: payer.id,
      sender: a1,
      recipients: [
        { userId: payer.id, deviceId: a1.deviceId, publicKey: a1.publicKey },
        { userId: earner.id, deviceId: b1.deviceId, publicKey: b1.publicKey },
      ],
      text: 'missing a device',
    }),
  });
  check(
    'an envelope missing a newly signed-in device is refused with the current list',
    stale.status === 409 &&
      stale.error === 'E2EE_DEVICES_CHANGED' &&
      stale.details?.devices?.some((d) => d.device_id === a2.deviceId),
    stale
  );

  const fixed = ref.encrypt({
    conversationId,
    senderUserId: payer.id,
    sender: a1,
    recipients: await recipientsOf(conversationId, payer.token),
    text: 'now for all three',
  });
  const resent = await post(`/conversations/${conversationId}/messages`, payer.token, { envelope: fixed });
  check('re-encrypted for the current list, it goes', resent.status === 201, resent);
  const onA2 = ref.decrypt({
    envelope: resent.data.message.envelope,
    conversationId,
    senderUserId: payer.id,
    senderPublicKey: a1.publicKey,
    reader: { userId: payer.id, device: a2 },
  }).text;
  check('and the sender’s other phone can read it', onA2 === 'now for all three');

  const ghost = ref.newDevice();
  const unknown = await post(`/conversations/${conversationId}/messages`, payer.token, {
    envelope: ref.encrypt({
      conversationId,
      senderUserId: payer.id,
      sender: ghost,
      recipients: await recipientsOf(conversationId, payer.token),
      text: 'from nowhere',
    }),
  });
  check(
    'a sending device the directory does not hold is refused',
    unknown.status === 409 && unknown.error === 'E2EE_DEVICE_UNKNOWN',
    unknown
  );

  const malformed = await post(`/conversations/${conversationId}/messages`, payer.token, {
    envelope: { ...fixed, epk: ref.b64(Buffer.alloc(16)) },
  });
  check('a malformed envelope is refused', malformed.status === 400, malformed);

  const extra = await post(`/conversations/${conversationId}/messages`, payer.token, {
    envelope: { ...fixed, sneaky: 'x', keys: fixed.keys },
    client_id: 'e2ee_extra',
  });
  const extraRow = await withPrisma((prisma) =>
    prisma.message.findUnique({ where: { id: extra.data?.message?.id ?? '' } })
  );
  check('unknown envelope fields are not stored', extraRow && !('sneaky' in (extraRow.envelope ?? {})), extraRow?.envelope);

  // A peer who has never opened an encrypting app.
  const legacyEarner = await createAccount({ name: 'E2EE Legacy', gender: 'female' });
  const legacyThread = await post(`/users/${legacyEarner.id}/conversation`, payer.token);
  const legacyId = legacyThread.data?.thread?.id;
  const noPeer = await post(`/conversations/${legacyId}/messages`, payer.token, {
    envelope: ref.encrypt({
      conversationId: legacyId,
      senderUserId: payer.id,
      sender: a1,
      recipients: await recipientsOf(legacyId, payer.token),
      text: 'hello?',
    }),
  });
  check(
    'someone with no encryption key cannot be sent an encrypted message',
    noPeer.status === 409 && noPeer.error === 'E2EE_PEER_UNAVAILABLE',
    noPeer
  );

  const plain = await post(`/conversations/${legacyId}/messages`, payer.token, { text: 'legacy hello' });
  check(
    'with E2EE_REQUIRED off, an out-of-date app can still send plaintext',
    plain.status === 201 || plain.error === 'E2EE_REQUIRED',
    plain
  );

  // ── Integrity, which the server cannot get past ──────────────────────────
  section('Integrity');

  const flipped = Buffer.from(ref.unb64(envelope.ct));
  flipped[0] ^= 0x01;
  const tampered = { ...envelope, ct: ref.b64(flipped) };
  let rejected = false;
  try {
    ref.decrypt({
      envelope: tampered,
      conversationId,
      senderUserId: payer.id,
      senderPublicKey: a1.publicKey,
      reader: { userId: earner.id, device: b1 },
    });
  } catch {
    rejected = true;
  }
  check('a modified ciphertext does not decrypt', rejected);

  rejected = false;
  try {
    ref.decrypt({
      envelope,
      conversationId: legacyId,
      senderUserId: payer.id,
      senderPublicKey: a1.publicKey,
      reader: { userId: earner.id, device: b1 },
    });
  } catch {
    rejected = true;
  }
  check('an envelope replayed into another conversation does not decrypt', rejected);

  rejected = false;
  try {
    ref.decrypt({
      envelope,
      conversationId,
      senderUserId: payer.id,
      // The server swapping in a key it controls for the sender's.
      senderPublicKey: ghost.publicKey,
      reader: { userId: earner.id, device: b1 },
    });
  } catch {
    rejected = true;
  }
  check('a message cannot be passed off as coming from a different device', rejected);

  // ── The socket path ──────────────────────────────────────────────────────
  section('Over the socket');

  const payerSocket = await online(payer);
  const socketSecret = 'over the socket';
  const heard = nextEvent(earnerSocket, 'message:new');
  const socketRecipients = await recipientsOf(conversationId, payer.token);
  const ack = await new Promise((resolve) =>
    payerSocket.emit(
      'message:send',
      {
        conversation_id: conversationId,
        client_id: 'e2ee_socket',
        envelope: ref.encrypt({
          conversationId,
          senderUserId: payer.id,
          sender: a1,
          recipients: socketRecipients,
          text: socketSecret,
        }),
      },
      resolve
    )
  );
  check('an encrypted send over the socket is acknowledged', ack?.success, ack);
  const heardMessage = await heard;
  check(
    'and arrives decryptable',
    heardMessage?.message?.envelope &&
      ref.decrypt({
        envelope: heardMessage.message.envelope,
        conversationId,
        senderUserId: payer.id,
        senderPublicKey: a1.publicKey,
        reader: { userId: earner.id, device: b1 },
      }).text === socketSecret
  );

  const huge = await new Promise((resolve) =>
    payerSocket.emit(
      'message:send',
      { conversation_id: legacyId, text: 'x'.repeat(10_000) },
      resolve
    )
  );
  check('the socket path enforces the same limits as HTTP', huge?.success === false, huge);

  // ── Revocation ───────────────────────────────────────────────────────────
  section('Signing out');

  await del(`/e2ee/devices/${a2.deviceId}`, payer.token);
  const afterRevoke = await get(`/conversations/${conversationId}/keys`, payer.token);
  const a2Row = afterRevoke.data?.devices?.find((d) => d.device_id === a2.deviceId);
  check('a signed-out device stays listed, inactive, so old messages still open', a2Row && !a2Row.active, a2Row);

  const toRevoked = await post(`/conversations/${conversationId}/messages`, payer.token, {
    envelope: ref.encrypt({
      conversationId,
      senderUserId: payer.id,
      sender: a1,
      recipients: afterRevoke.data.devices.map((d) => ({
        userId: d.user_id,
        deviceId: d.device_id,
        publicKey: ref.unb64(d.public_key),
      })),
      text: 'to a revoked phone',
    }),
  });
  check(
    'nothing new may be encrypted for it',
    toRevoked.status === 409 && toRevoked.error === 'E2EE_DEVICES_CHANGED',
    toRevoked
  );

  const back = await register(payer, a2);
  check('signing back in on the same phone reactivates its key', back.data?.device?.active, back);

  // ── Deleting and reporting ───────────────────────────────────────────────
  section('Deleting and reporting');

  const deleted = await del(`/conversations/messages/${resent.data.message.id}`, payer.token);
  const deletedRow = await withPrisma((prisma) =>
    prisma.message.findUnique({ where: { id: resent.data.message.id } })
  );
  check('deleting a message removes its ciphertext too', deleted.success && deletedRow.envelope === null, deletedRow);

  const reported = await post('/moderation/report', earner.token, {
    user_id: payer.id,
    reason: 'harassment',
    evidence: [
      { message_id: messageId, text: secret },
      { message_id: 'not_a_real_message_id', text: 'invented' },
    ],
  });
  check('a report can carry messages the reporter decrypted', reported.status === 201, reported);
  const report = await withPrisma((prisma) =>
    prisma.report.findUnique({ where: { id: reported.data?.report_id ?? '' } })
  );
  check(
    'only messages really in their conversation are kept, attributed from the stored row',
    report?.evidence?.length === 1 &&
      report.evidence[0].from === 'reported' &&
      report.evidence[0].text === secret &&
      report.evidence[0].supplied_by_reporter === true,
    report?.evidence
  );

  const logoutAll = await post('/auth/logout', payer.token, { all_devices: true });
  const devicesAfter = await withPrisma((prisma) =>
    prisma.e2eeDevice.findMany({ where: { userId: payer.id } })
  );
  check(
    'signing out everywhere revokes every encryption key',
    logoutAll.success && devicesAfter.length === 2 && devicesAfter.every((d) => d.revokedAt),
    devicesAfter
  );

  payerSocket.close();
  earnerSocket.close();
}

run()
  .catch((err) => fail(`
Crashed: ${err.stack ?? err}`))
  .finally(async () => {
    try {
      await cleanup();
    } catch (err) {
      console.error('cleanup failed', err);
    }
    const { passed, failed } = summary();
    console.log(`
${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
