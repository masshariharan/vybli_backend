'use strict';

const admin = require('firebase-admin');

const prisma = require('../config/prisma');
const env = require('../config/env');
const firebase = require('./firebase.service');

/**
 * Notifications that arrive when the app is not on screen.
 *
 * The socket delivers everything while Vybli is open and connected. This is
 * the other half: the phone in a pocket, the app swiped away, the screen off.
 * Without it the product only works while someone is already looking at it —
 * a call rings into a closed app and nobody ever knows it happened.
 *
 * **Two shapes of message, and the difference is not cosmetic.**
 *
 *  * A **chat message** is sent with an FCM `notification` block. Android
 *    itself draws it when the app is backgrounded, which is the most reliable
 *    delivery there is: no Dart has to run, nothing has to survive a doze, and
 *    an OEM that kills background isolates cannot swallow it. The matching
 *    `data` block rides along for when the app *is* running, and for when the
 *    notification is tapped and the app needs to know which thread to open.
 *
 *  * A **call** is sent as data only, at high priority. It has to be, because
 *    a ring is not a row that sits in a tray: it needs two buttons, a
 *    full-screen intent over the lock screen and a sound that keeps going —
 *    none of which is expressible in the `notification` block the OS renders.
 *    The client builds it instead, which means the client's background
 *    handler has to run, which is what `priority: high` buys.
 *
 * **A ring expires.** Call pushes carry a short TTL, so a phone that comes
 * back on the network two minutes later does not start ringing for a call
 * that ended long ago. FCM drops the undeliverable message instead.
 *
 * Every failure here is swallowed. A push is the last step of an action that
 * has already succeeded — the message is stored and delivered, the call is
 * ringing over the socket — and a notification that could not be sent should
 * not turn any of that into an error somebody sees.
 */

/** How long a ring is worth delivering. Past this the call is over. */
const CALL_TTL_SECONDS = 45;

/** Android channel ids. The client creates both at startup, under these names. */
const CHANNEL = {
  messages: 'vybli_messages',
  calls: 'vybli_calls',
};

let warned = false;

/**
 * The messaging client, or null when this deployment cannot send.
 *
 * Sending requires a **service account**. Verifying a sign-in does not — that
 * checks a signature against Google's public certificates — which is why this
 * server has always run happily on `FIREBASE_PROJECT_ID` alone, and why push
 * is the one feature that needs more than the project id. The warning fires
 * once rather than per notification: a line per undelivered message would
 * bury the one line that explains why.
 */
function messaging() {
  if (!env.firebase.hasServiceAccount) {
    if (!warned) {
      warned = true;
      console.warn(
        '[push] disabled: set FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY to ' +
          'notify phones that are not currently connected'
      );
    }
    return null;
  }
  const app = firebase.app();
  return app ? admin.messaging(app) : null;
}

/** Whether this deployment can push at all — read by the startup banner. */
function enabled() {
  return env.firebase.hasServiceAccount;
}

/**
 * Remembers where to reach a phone.
 *
 * Upsert on the **token**, not on the pair: FCM hands the same install the
 * same token across a sign-out and a sign-in, so registering one that already
 * belongs to another account moves it rather than creating a second row. The
 * phone belongs to whoever is signed in on it now, and leaving the old row in
 * place would send that account's messages to somebody else's screen.
 */
async function register(userId, { token, platform = 'android', deviceName = null }) {
  if (!token) return null;
  return prisma.deviceToken.upsert({
    where: { token },
    update: { userId, platform, deviceName, lastSeenAt: new Date() },
    create: { userId, token, platform, deviceName },
  });
}

/**
 * Forgets one phone — on sign-out, from the device doing the signing out.
 *
 * Scoped to the account, so a stale client cannot silence somebody else's
 * phone by guessing a token.
 */
async function unregister(userId, token) {
  if (!token) return 0;
  const { count } = await prisma.deviceToken.deleteMany({ where: { userId, token } });
  return count;
}

/** Every token for an account, most recently seen first. */
function tokensFor(userId) {
  return prisma.deviceToken.findMany({
    where: { userId },
    select: { token: true },
    orderBy: { lastSeenAt: 'desc' },
    // A sane ceiling. Anyone with more live installs than this has a problem
    // no notification is going to solve.
    take: 20,
  });
}

/**
 * Drops the tokens FCM says are dead.
 *
 * `registration-token-not-registered` means the app was uninstalled, its data
 * cleared, or the token rotated long enough ago that the old one is gone.
 * There is no recovery and no retry worth making, so the row goes — otherwise
 * every future notification pays for a send that cannot arrive.
 */
async function prune(tokens, responses) {
  const dead = [];
  responses.forEach((response, i) => {
    if (response.success) return;
    const code = response.error?.code ?? '';
    if (
      code === 'messaging/registration-token-not-registered' ||
      code === 'messaging/invalid-registration-token' ||
      code === 'messaging/invalid-argument'
    ) {
      dead.push(tokens[i]);
    }
  });
  if (!dead.length) return;
  await prisma.deviceToken
    .deleteMany({ where: { token: { in: dead } } })
    .catch((err) => console.error('[push] could not prune dead tokens', err));
}

/** The one send. Returns how many devices took it. */
async function deliver(userId, message) {
  const fcm = messaging();
  if (!fcm) return 0;

  const rows = await tokensFor(userId);
  if (!rows.length) return 0;
  const tokens = rows.map((r) => r.token);

  try {
    const result = await fcm.sendEachForMulticast({ ...message, tokens });
    if (result.failureCount) await prune(tokens, result.responses);
    return result.successCount;
  } catch (err) {
    console.error(`[push] send failed for ${userId}`, err);
    return 0;
  }
}

/**
 * A chat message, or anything else that belongs in the tray.
 *
 * `collapseKey` and the Android `tag` are the same string — the conversation
 * id — so twenty messages from one person replace each other rather than
 * stacking twenty rows deep. What is on screen is always the latest one.
 */
function sendNotification(userId, { title, body, data = {}, collapseKey = null }) {
  return deliver(userId, {
    notification: { title, body },
    data: stringify({ ...data, click_action: 'FLUTTER_NOTIFICATION_CLICK' }),
    android: {
      priority: 'high',
      collapseKey: collapseKey ?? undefined,
      notification: {
        channelId: CHANNEL.messages,
        tag: collapseKey ?? undefined,
        // The app's own monochrome mark, not the launcher icon: Android tints
        // the small icon, and a full-colour launcher icon comes out a white
        // blob.
        icon: 'ic_notification',
        color: '#7B2FF0',
        defaultSound: true,
      },
    },
    apns: {
      headers: { 'apns-priority': '10' },
      payload: { aps: { sound: 'default' } },
    },
  });
}

/**
 * A ring.
 *
 * Data only — see the note at the top of the file. The client turns this into
 * the full-screen, two-button notification, so a phone whose app cannot be
 * woken shows nothing at all rather than a silent "incoming call" row that
 * does nothing when tapped.
 */
function sendCall(
  userId,
  { callId, type, callerId, callerName, avatarUrl = null, ratePerMinute = 0 }
) {
  return deliver(userId, {
    data: stringify({
      kind: 'call',
      call_id: callId,
      call_type: type,
      user_id: callerId,
      name: callerName,
      avatar_url: avatarUrl ?? '',
      rate_per_minute: ratePerMinute,
    }),
    android: {
      priority: 'high',
      ttl: CALL_TTL_SECONDS * 1000,
    },
    apns: {
      headers: {
        'apns-priority': '10',
        'apns-push-type': 'alert',
        'apns-expiration': `${Math.floor(Date.now() / 1000) + CALL_TTL_SECONDS}`,
      },
      payload: {
        aps: {
          alert: { title: `${callerName} is calling`, body: `${type} call` },
          sound: 'default',
          'content-available': 1,
        },
      },
    },
  });
}

/**
 * Tells the phones a call is over, so a ring still on screen comes down.
 *
 * Without this, declining on one device or the caller giving up leaves every
 * other phone the account is signed in on ringing at a call that no longer
 * exists — and answering it lands on an error instead of a conversation.
 */
function sendCallCancelled(userId, { callId, reason = 'ended' }) {
  return deliver(userId, {
    data: stringify({ kind: 'call_cancelled', call_id: callId, reason }),
    android: { priority: 'high', ttl: CALL_TTL_SECONDS * 1000 },
    apns: {
      headers: { 'apns-priority': '10', 'apns-push-type': 'background' },
      payload: { aps: { 'content-available': 1 } },
    },
  });
}

/** FCM data values must be strings, or the whole message is rejected. */
function stringify(data) {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => [key, String(value)])
  );
}

/**
 * A data-only push that shows nothing — a message in a thread the recipient
 * muted. It exists so the phone can acknowledge delivery (the second tick)
 * without the app open; a muted chat still delivers, it just does not shout.
 */
function sendSilent(userId, data) {
  return deliver(userId, {
    data: stringify(data),
    android: { priority: 'high' },
    apns: {
      headers: { 'apns-priority': '5', 'apns-push-type': 'background' },
      payload: { aps: { 'content-available': 1 } },
    },
  });
}

module.exports = {
  CHANNEL,
  sendSilent,
  enabled,
  register,
  unregister,
  sendNotification,
  sendCall,
  sendCallCancelled,
};
