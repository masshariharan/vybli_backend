'use strict';

const admin = require('firebase-admin');

const prisma = require('../config/prisma');
const env = require('../config/env');
const firebase = require('./firebase.service');

/**
 * Notifications that arrive when the app is not on screen — **messages
 * only.**
 *
 * The socket delivers everything while Vybli is open and connected. This is
 * the other half for chat: the phone in a pocket, the app swiped away, the
 * screen off. A chat message is sent with an FCM `notification` block, which
 * Android itself draws when the app is backgrounded — the most reliable
 * delivery there is: no Dart has to run, nothing has to survive a doze, and
 * an OEM that kills background isolates cannot swallow it. The matching
 * `data` block rides along for when the app *is* running, and for the tap.
 *
 * **Calls are never pushed.** A call rings only an app that is open and
 * connected, over the socket, and is refused up front when the other person
 * is not (see `relationship.assertCanCall`). There used to be a data-only
 * "ring" push that drew a full-screen incoming-call notification; it opened
 * the app onto a call seconds late, often one already over, and it is gone.
 *
 * Every failure here is swallowed. A push is the last step of an action that
 * has already succeeded — the message is stored and delivered, the call is
 * ringing over the socket — and a notification that could not be sent should
 * not turn any of that into an error somebody sees.
 */


/** Android channel id. The client creates it at startup, under this name. */
const CHANNEL = {
  messages: 'vybli_messages',
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
};
