'use strict';

const prisma = require('../config/prisma');
const { errors } = require('../utils/errors');
const { refreshTokenTtlMs } = require('../utils/tokens');

/**
 * The directory of end-to-end encryption device keys.
 *
 * Public keys only — see the `E2eeDevice` model for what this table is and is
 * not, and `utils/e2ee` for the message format that uses it. Nothing here can
 * decrypt anything.
 */

/**
 * A device still counts as signed in if it registered within the lifetime of
 * a refresh token. Past that, whatever session it had is gone, and encrypting
 * for it would only grow every message for a phone that cannot read them.
 */
function activeSince() {
  return new Date(Date.now() - refreshTokenTtlMs());
}

function serializeDevice(row) {
  return {
    user_id: row.userId,
    device_id: row.deviceId,
    public_key: row.publicKey,
    platform: row.platform,
    active: !row.revokedAt && row.lastSeenAt >= activeSince(),
    created_at: row.createdAt.toISOString(),
    last_seen_at: row.lastSeenAt.toISOString(),
  };
}

/**
 * Registers (or re-registers) this phone's key.
 *
 * Called on every arrival at signed-in, like the push token, so `lastSeenAt`
 * says which devices are still real. Re-registering a revoked device brings
 * it back: signing out and in again on the same phone keeps the same key, and
 * with it every message ever encrypted to that key.
 *
 * A device id is bound to its key for life. Registering the same id with a
 * *different* key is refused, not overwritten — silently replacing a key is
 * precisely what a peer's app would be right to be alarmed by, so a phone
 * that genuinely has a new key picks a new id and says so honestly.
 */
async function registerDevice(user, { deviceId, publicKey, platform }) {
  const existing = await prisma.e2eeDevice.findUnique({
    where: { userId_deviceId: { userId: user.id, deviceId } },
  });
  if (existing && existing.publicKey !== publicKey) throw errors.e2eeDeviceKeyMismatch();

  const now = new Date();
  const row = existing
    ? await prisma.e2eeDevice.update({
        where: { id: existing.id },
        data: { lastSeenAt: now, revokedAt: null, platform },
      })
    : await prisma.e2eeDevice.create({
        data: { userId: user.id, deviceId, publicKey, platform, lastSeenAt: now },
      });
  return serializeDevice(row);
}

/** Signs one device out of encrypted chat. Idempotent. */
async function revokeDevice(user, deviceId) {
  await prisma.e2eeDevice.updateMany({
    where: { userId: user.id, deviceId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Every device of this user — "log out everywhere" and account deletion. */
async function revokeAllFor(userId) {
  await prisma.e2eeDevice.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** This account's own devices, newest first. */
async function listOwn(user) {
  const rows = await prisma.e2eeDevice.findMany({
    where: { userId: user.id },
    orderBy: { lastSeenAt: 'desc' },
  });
  return rows.map(serializeDevice);
}

/** The devices a message to these users has to be encrypted for. */
async function activeDevicesOf(userIds) {
  return prisma.e2eeDevice.findMany({
    where: { userId: { in: userIds }, revokedAt: null, lastSeenAt: { gte: activeSince() } },
    orderBy: [{ userId: 'asc' }, { createdAt: 'asc' }],
  });
}

/**
 * Both members' devices, for a sender about to encrypt or a reader about to
 * decrypt.
 *
 * Revoked and stale devices are included, marked `active: false`: a message
 * sent from a phone that has since signed out still names that phone's key,
 * and its readers need that key to open it. A sender encrypts only for the
 * active ones.
 *
 * The caller has already established membership (`getConversationOr404`).
 */
async function devicesForConversation(conversation) {
  const rows = await prisma.e2eeDevice.findMany({
    where: { userId: { in: [conversation.userAId, conversation.userBId] } },
    orderBy: [{ userId: 'asc' }, { createdAt: 'asc' }],
  });
  return rows.map(serializeDevice);
}

/**
 * Devices of several people at once — what the Chats list needs to decrypt a
 * page of previews without one request per row.
 *
 * Only the caller and people the caller shares a conversation with: anyone
 * else's keys are nobody's business here, public or not, since the list of
 * devices is itself a record of when somebody signs in where.
 */
async function devicesOfContacts(user, userIds) {
  const wanted = [...new Set(userIds)].filter((id) => id !== user.id);
  const shared = wanted.length
    ? await prisma.conversation.findMany({
        where: {
          OR: [
            { userAId: user.id, userBId: { in: wanted } },
            { userBId: user.id, userAId: { in: wanted } },
          ],
        },
        select: { userAId: true, userBId: true },
      })
    : [];
  const allowed = new Set([user.id]);
  for (const c of shared) allowed.add(c.userAId === user.id ? c.userBId : c.userAId);
  const rows = await prisma.e2eeDevice.findMany({
    where: { userId: { in: [...allowed] } },
    orderBy: [{ userId: 'asc' }, { createdAt: 'asc' }],
  });
  return rows.map(serializeDevice);
}

/**
 * Checks an envelope was encrypted for exactly the devices that should be
 * able to read it: every active device of both people, and nothing else.
 *
 *  * A **missing** device is the case that matters — somebody signed in on a
 *    new phone since the sender last fetched the list, and that phone would
 *    receive a message it can never open.
 *  * An **extra** one means the sender's list is stale the other way (a
 *    device signed out) — harmless to that device, which cannot read it
 *    without a live key anyway, but a sign the sender's picture is out of
 *    date, and cheap to correct.
 *
 * Either way the answer is the current list (`E2EE_DEVICES_CHANGED`), which
 * the app re-encrypts for and resends at once — the person typing never sees
 * it. This is the same arrangement Signal's server makes with its clients.
 *
 * The sending device itself must be a live device of the sender: the reader
 * looks its key up by that id, and a key the directory does not hold (or
 * holds as revoked) is a message nobody should trust.
 */
async function assertEnvelopeCoversConversation(envelope, { senderId, peerId }) {
  const devices = await activeDevicesOf([senderId, peerId]);

  const sender = devices.find((d) => d.userId === senderId && d.deviceId === envelope.sender_device);
  if (!sender) throw errors.e2eeDeviceUnknown();

  if (!devices.some((d) => d.userId === peerId)) throw errors.e2eePeerUnavailable();

  const expected = new Set(devices.map((d) => `${d.userId}/${d.deviceId}`));
  const given = new Set(envelope.keys.map((k) => `${k.user}/${k.device}`));
  const same = expected.size === given.size && [...expected].every((id) => given.has(id));
  if (!same) throw errors.e2eeDevicesChanged(devices.map(serializeDevice));
}

module.exports = {
  registerDevice,
  revokeDevice,
  revokeAllFor,
  listOwn,
  activeDevicesOf,
  devicesForConversation,
  devicesOfContacts,
  assertEnvelopeCoversConversation,
  serializeDevice,
};
