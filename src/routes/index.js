'use strict';

const express = require('express');

const { authenticate, requireOnboarded, requireEarner } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../middleware/error');
const {
  otpRequestLimiter,
  otpVerifyLimiter,
  writeLimiter,
  supportLimiter,
  paymentLimiter,
} = require('../middleware/rateLimit');
const S = require('../validators/schemas');
const prisma = require('../config/prisma');
const env = require('../config/env');
const { errors } = require('../utils/errors');

const authController = require('../controllers/auth.controller');
const onboardingController = require('../controllers/onboarding.controller');
const profileController = require('../controllers/profile.controller');
const discoveryController = require('../controllers/discovery.controller');
const favoriteController = require('../controllers/favorite.controller');
const chatController = require('../controllers/chat.controller');
const e2eeController = require('../controllers/e2ee.controller');
const callController = require('../controllers/call.controller');
const walletController = require('../controllers/wallet.controller');
const {
  notifications,
  devices,
  moderation,
  verification,
  support,
} = require('../controllers/misc.controller');
const livekitController = require('../controllers/livekit.controller');
const adminRoutes = require('./admin');

/**
 * The whole HTTP surface, in the order a user meets it: sign in, finish
 * onboarding, browse, connect, talk, pay.
 *
 * Three middleware tiers, applied deliberately:
 *
 *   `authenticate`     — who are you
 *   `requireOnboarded` — you have a usable profile
 *   `requireEarner`    — this feature only exists for Earn Money accounts
 *
 * Onboarding routes take the first and not the second: they are how you leave
 * the incomplete state, so gating them on being complete would lock everyone
 * out of finishing.
 */
const router = express.Router();
const h = asyncHandler;

// ── Health ──────────────────────────────────────────────────────────────────

// Health, and it actually checks.
//
// This used to answer `ok` as long as the process was running, which is the
// one thing a health check does not need to establish — if the process were
// down, nothing would answer at all. A server whose database has gone away
// still accepts connections and still returns 200 here, so a load balancer
// keeps it in rotation and every real request 500s behind a green light.
//
// `SELECT 1` is the cheapest question that distinguishes the two. The timeout
// matters as much as the query: a pool that is exhausted or a database that is
// wedged will hang rather than refuse, and a health check that hangs reads as
// a timeout to some probes and as success to others.
router.get('/health', async (_req, res) => {
  const started = Date.now();
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('database did not answer in 2s')), 2000)
      ),
    ]);
  } catch (error) {
    // The reason goes to this process's log, not to whoever asked: a
    // driver's error names hosts, ports and users, and this route is public.
    console.error('[health] database unreachable:', error.message);
    return res.status(503).json({
      success: false,
      message: 'Vybli API is up but the database is not reachable',
      error: 'DATABASE_UNAVAILABLE',
      data: { status: 'degraded', database: 'unreachable' },
    });
  }

  return res.json({
    success: true,
    message: 'Vybli API is up',
    data: { status: 'ok', database: 'ok', latency_ms: Date.now() - started },
  });
});

// ── App version ─────────────────────────────────────────────────────────────

// Public: the app asks before anyone signs in, because a build too old to
// talk to this server has to be stopped at the door, not after the login
// screen. Whether an update exists at all is Google Play's answer, not this
// one — see `appUpdate` in `config/env`.
router.get('/app/version', (_req, res) =>
  res.json({
    success: true,
    message: 'App version policy',
    data: {
      android: {
        min_supported_build: env.appUpdate.androidMinSupportedBuild,
        message: env.appUpdate.message || null,
      },
    },
  })
);

// ── LiveKit ─────────────────────────────────────────────────────────────────

// Public by design: LiveKit posts here from its own infrastructure with no
// user session. The request is authenticated by its signature instead, which
// needs the body byte-for-byte as it was signed — hence `express.raw` rather
// than the global JSON parser. LiveKit sends `application/webhook+json`.
router.post(
  '/livekit/webhook',
  express.raw({ type: ['application/webhook+json', 'application/json'], limit: '256kb' }),
  h(livekitController.webhook)
);

// Lets the app find out at startup whether calling is available on this
// deployment, without having to place a call to discover it is not.
router.get('/livekit/status', authenticate, livekitController.status);

// ── Admin ───────────────────────────────────────────────────────────────────
//
// Mounted before the user routes so `/admin/users` can never be shadowed by a
// `/users/:id` pattern. Its own auth middleware lives inside — the user
// `authenticate` never runs on an admin request, and the two token types are
// signed with different secrets so neither can be replayed as the other.

router.use('/admin', adminRoutes);

// ── Auth ────────────────────────────────────────────────────────────────────

const auth = express.Router();

// The OTP sign-in exists only where something can deliver a code. A
// Firebase-only deployment used to mount it anyway: each request stored a
// fresh code, failed to text it, and left it live in the database — a code
// nobody was sent, so nobody noticed it being guessed at.
const otpEnabled = (_req, _res, next) =>
  env.sms.configured || env.otp.devMode
    ? next()
    : next(errors.notFound('Route', 'ROUTE_NOT_FOUND'));

auth.post(
  '/otp/request',
  otpEnabled,
  otpRequestLimiter,
  validate({ body: S.auth.requestOtp }),
  h(authController.requestOtp)
);
auth.post(
  '/otp/verify',
  otpEnabled,
  otpVerifyLimiter,
  validate({ body: S.auth.verifyOtp }),
  h(authController.verifyOtp)
);
// Firebase does the phone verification; this trades its token for one of
// ours. Rate-limited like the OTP verify it replaces — the Firebase token is
// already proof of a verified number, but the endpoint still creates accounts.
auth.post(
  '/firebase/verify',
  otpVerifyLimiter,
  validate({ body: S.auth.firebaseSignIn }),
  h(authController.firebaseSignIn)
);

auth.post('/refresh', validate({ body: S.auth.refresh }), h(authController.refresh));

auth.use(authenticate);
auth.get('/me', h(authController.me));
auth.post('/logout', validate({ body: S.auth.logout }), h(authController.logout));
// Irreversible, so it is rate-limited like the other destructive paths — but
// not re-confirmed by SMS. The client owns the confirmation; a valid access
// token is the authority.
auth.delete(
  '/account',
  writeLimiter,
  validate({ body: S.auth.deleteAccount }),
  h(authController.deleteAccount)
);

router.use('/auth', auth);

// ── Reference data ──────────────────────────────────────────────────────────
// Public: the onboarding screens read these before anyone is signed in.
//
// Neither catalogue is served here. Cities and languages are both static, so
// both ship compiled into the app — see `catalogue/` there, and `UserLanguage`
// in the schema. What is left is the two things the app cannot know: how many
// people are in a city, and roughly where an IP address is.

router.get('/cities/stats', h(discoveryController.cityStats));

// A coordinate, never a city — which city a point is in is decided on the
// phone. Public because the location step runs before the account is
// finished; the IP is read from the request and nothing is stored.
router.get('/location/ip-estimate', h(discoveryController.ipEstimate));
// Public for the same reason — the avatar step is also pre-onboarding.
router.get(
  '/avatars',
  validate({ query: S.reference.avatarQuery }),
  h(discoveryController.avatars)
);

// ── Onboarding ──────────────────────────────────────────────────────────────

const onboarding = express.Router();
onboarding.use(authenticate);

onboarding.get('/status', h(onboardingController.getStatus));
onboarding.post(
  '/gender',
  validate({ body: S.onboarding.gender }),
  h(onboardingController.setGender)
);
onboarding.post(
  '/age',
  validate({ body: S.onboarding.age }),
  h(onboardingController.setAge)
);
onboarding.post(
  '/languages',
  validate({ body: S.onboarding.languages }),
  h(onboardingController.setLanguages)
);
onboarding.post(
  '/location',
  validate({ body: S.onboarding.location }),
  h(onboardingController.setLocation)
);
onboarding.post(
  '/profile',
  validate({ body: S.onboarding.profile }),
  h(onboardingController.setProfileBasics)
);
onboarding.post('/complete', h(onboardingController.complete));

router.use('/onboarding', onboarding);

// ── Verification ────────────────────────────────────────────────────────────
// Read-only. Review is manual and administrator-driven — see the admin
// `/verifications` routes — so there is nothing here for a client to submit.

const verify = express.Router();
verify.use(authenticate);

verify.get('/status', h(verification.status));

router.use('/verification', verify);

// ── Everything past this point needs a finished profile ─────────────────────

// ── Me ──────────────────────────────────────────────────────────────────────

const me = express.Router();
me.use(authenticate);

// Readable while onboarding — the client shows the profile it is building.
me.get('/', h(profileController.getMe));
me.patch('/', validate({ body: S.profile.update }), h(profileController.updateMe));
me.put(
  '/presence',
  validate({ body: S.profile.presence }),
  h(profileController.setPresence)
);
// A woman's voice and video levels, with her progress to the next — see
// `services/pricing.service`. Men have none.
me.get('/levels', h(profileController.getLevels));
// The phone's last live fix, for the admin panel. Readable by nobody else —
// see `UserProfile.locationLat`.
me.put(
  '/location',
  validate({ body: S.profile.location }),
  h(profileController.setLocation)
);
// The avatar. Just an id from the predefined catalog — the only way an
// avatar is ever set, so a client can never point a profile at an image
// this server does not itself serve.
me.put(
  '/avatar',
  writeLimiter,
  validate({ body: S.profile.setAvatar }),
  h(profileController.setAvatar)
);

me.get('/languages', h(profileController.getMyLanguages));
me.put(
  '/languages',
  validate({ body: S.reference.setLanguages }),
  h(profileController.setMyLanguages)
);

me.get('/settings/privacy', h(profileController.getPrivacy));
me.patch(
  '/settings/privacy',
  validate({ body: S.settings.privacy }),
  h(profileController.updatePrivacy)
);
me.get('/settings/notifications', h(profileController.getNotificationSettings));
me.patch(
  '/settings/notifications',
  validate({ body: S.settings.notifications }),
  h(profileController.updateNotificationSettings)
);
me.get('/settings/discovery', h(profileController.getDiscoverySettings));
me.patch(
  '/settings/discovery',
  validate({ body: S.settings.discovery }),
  h(profileController.updateDiscoverySettings)
);
me.post('/settings/discovery/reset', h(profileController.resetDiscoverySettings));

router.use('/me', me);

// ── Users & discovery ───────────────────────────────────────────────────────

const users = express.Router();
users.use(authenticate, requireOnboarded);

users.get(
  '/discover',
  validate({ query: S.discovery.feed }),
  h(discoveryController.feed)
);
users.post(
  '/random-match',
  validate({ body: S.discovery.randomMatch }),
  h(discoveryController.randomMatch)
);
users.get(
  '/:id',
  validate({ params: S.users.idParam }),
  h(profileController.getPublic)
);
// Opens (creating if needed) the conversation with this person — the
// profile's Chat button. No approval step: eligibility is enforced inside
// `chatService.openOrCreate`.
users.post(
  '/:id/conversation',
  writeLimiter,
  validate({ params: S.users.idParam }),
  h(chatController.openConversation)
);

router.use('/users', users);

// ── Favourites ──────────────────────────────────────────────────────────────

const favorites = express.Router();
favorites.use(authenticate, requireOnboarded);

favorites.get('/', validate({ query: S.pagination }), h(favoriteController.list));
// Every starred id, no profiles — the app's stars; the tab pages `/`.
favorites.get('/ids', h(favoriteController.ids));
favorites.post(
  '/:id',
  writeLimiter,
  validate({ params: S.favorites.userParam }),
  h(favoriteController.add)
);
favorites.delete(
  '/:id',
  validate({ params: S.favorites.userParam }),
  h(favoriteController.remove)
);

router.use('/favorites', favorites);

// ── Chat ────────────────────────────────────────────────────────────────────

const chat = express.Router();

// A delivery ack from a push, proven by the receipt the push carried — no
// sign-in, deliberately: it is sent from the phone's background handler, where
// refreshing an expired access token would rotate the session out from under
// the app still in memory. Declared before `authenticate` for that reason.
chat.post(
  '/messages/delivered/receipt',
  validate({ body: S.chat.deliveredReceipt }),
  h(chatController.markDeliveredByReceipt)
);

chat.use(authenticate, requireOnboarded);

chat.get('/', validate({ query: S.chat.list }), h(chatController.listThreads));
chat.get('/unread', h(chatController.unreadSummary));
// Delivery acks from a push, when the app had no socket to ack on.
chat.post(
  '/messages/delivered',
  validate({ body: S.chat.delivered }),
  h(chatController.markDelivered)
);
chat.get(
  '/:id',
  validate({ params: S.chat.conversationParam, query: S.chat.history }),
  h(chatController.getThread)
);
chat.post(
  '/:id/messages',
  writeLimiter,
  validate({ params: S.chat.conversationParam, body: S.chat.send }),
  h(chatController.sendMessage)
);
// Both members' device keys, for encrypting to them and decrypting from them.
chat.get(
  '/:id/keys',
  validate({ params: S.chat.conversationParam }),
  h(e2eeController.conversationKeys)
);
chat.post(
  '/:id/read',
  validate({ params: S.chat.conversationParam }),
  h(chatController.markRead)
);
chat.patch(
  '/:id/mute',
  validate({ params: S.chat.conversationParam, body: S.chat.mute }),
  h(chatController.setMuted)
);
chat.patch(
  '/:id/pin',
  validate({ params: S.chat.conversationParam, body: S.chat.pin }),
  h(chatController.setPinned)
);
// Disappearing messages: 24 hours or 7 days, for both people.
chat.patch(
  '/:id/timer',
  validate({ params: S.chat.conversationParam, body: S.chat.timer }),
  h(chatController.setMessageTimer)
);
// Chat theme: the conversation's look, for both people.
chat.patch(
  '/:id/theme',
  validate({ params: S.chat.conversationParam, body: S.chat.theme }),
  h(chatController.setChatTheme)
);
// Deletes the chat for this side only; the other person keeps theirs.
chat.delete(
  '/:id',
  validate({ params: S.chat.conversationParam }),
  h(chatController.deleteConversation)
);
chat.delete(
  '/messages/:id',
  validate({ params: S.chat.conversationParam }),
  h(chatController.deleteMessage)
);

router.use('/conversations', chat);

// ── End-to-end encryption keys ──────────────────────────────────────────────
//
// The public-key directory — see `services/e2ee.service`. Signed-in only, not
// onboarded: a phone registers its key on arriving at signed-in, the same
// moment it registers its push token, whichever step of sign-up it is on.

const keys = express.Router();
keys.use(authenticate);
keys.get('/devices', h(e2eeController.listDevices));
keys.post(
  '/devices/lookup',
  validate({ body: S.e2ee.lookup }),
  h(e2eeController.lookupDevices)
);
keys.put(
  '/devices/:deviceId',
  writeLimiter,
  validate({ params: S.e2ee.deviceParam, body: S.e2ee.register }),
  h(e2eeController.registerDevice)
);
keys.delete(
  '/devices/:deviceId',
  validate({ params: S.e2ee.deviceParam }),
  h(e2eeController.revokeDevice)
);
router.use('/e2ee', keys);

// ── Calls ───────────────────────────────────────────────────────────────────

const calls = express.Router();
calls.use(authenticate, requireOnboarded);

calls.get('/active', h(callController.getActive));
calls.get('/history', validate({ query: S.calls.history }), h(callController.history));
calls.delete('/history', h(callController.clearHistory));
calls.post(
  '/',
  writeLimiter,
  validate({ body: S.calls.start }),
  h(callController.start)
);
calls.post(
  '/:id/accept',
  validate({ params: S.calls.callParam }),
  h(callController.accept)
);
// The callee's phone confirming the ring reached it — the socket's
calls.post(
  '/:id/reject',
  validate({ params: S.calls.callParam }),
  h(callController.reject)
);
calls.post(
  '/:id/cancel',
  validate({ params: S.calls.callParam }),
  h(callController.cancel)
);
calls.post(
  '/:id/end',
  validate({ params: S.calls.callParam, body: S.calls.end }),
  h(callController.end)
);
calls.post(
  '/:id/rate',
  validate({ params: S.calls.callParam, body: S.calls.rate }),
  h(callController.rate)
);
// A fresh LiveKit join token for a call already in progress — for a client
// reconnecting after the original short-lived one expired.
calls.post(
  '/:id/token',
  validate({ params: S.calls.callParam }),
  h(callController.token)
);
// The REST fallback for in-call chat — the socket path (`call:message`) is
// the one actually used while connected; this exists for the same reason
// every other call action has one.
calls.post(
  '/:id/message',
  validate({ params: S.calls.callParam, body: S.calls.message }),
  h(callController.sendMessage)
);
calls.delete(
  '/:id',
  validate({ params: S.calls.callParam }),
  h(callController.remove)
);

router.use('/calls', calls);

// ── Wallet ──────────────────────────────────────────────────────────────────

const wallet = express.Router();
wallet.use(authenticate, requireOnboarded);

wallet.get('/', h(walletController.summary));
wallet.get('/packages', h(walletController.packages));
wallet.get('/payments/status', h(walletController.paymentsStatus));
wallet.get(
  '/transactions',
  validate({ query: S.wallet.transactions }),
  h(walletController.transactions)
);
wallet.post(
  '/purchase',
  paymentLimiter,
  validate({ body: S.wallet.purchase }),
  h(walletController.purchase)
);

wallet.get('/vip/plans', h(walletController.vipPlans));
wallet.post(
  '/vip/purchase',
  paymentLimiter,
  validate({ body: S.wallet.vipPurchase }),
  h(walletController.purchaseVip)
);

// Earnings and withdrawals exist only for Earn Money accounts. For anyone else
// the answer is not an empty list, it is that the feature does not apply.
wallet.get(
  '/earnings',
  requireEarner,
  validate({ query: S.pagination }),
  h(walletController.earnings)
);
wallet.post(
  '/withdraw',
  paymentLimiter,
  requireEarner,
  validate({ body: S.wallet.withdraw }),
  h(walletController.withdraw)
);
wallet.get('/upi-account', requireEarner, h(walletController.getUpiAccount));
wallet.put(
  '/upi-account',
  requireEarner,
  validate({ body: S.wallet.upiAccount }),
  h(walletController.setUpiAccount)
);

router.use('/wallet', wallet);

// ── Notifications ───────────────────────────────────────────────────────────

const notifs = express.Router();
notifs.use(authenticate);

notifs.get('/', validate({ query: S.notifications.list }), h(notifications.list));
notifs.get('/unread-count', h(notifications.unreadCount));
notifs.post('/read-all', h(notifications.markAllRead));
notifs.post(
  '/:id/read',
  validate({ params: S.notifications.param }),
  h(notifications.markRead)
);

router.use('/notifications', notifs);

// ── Devices ─────────────────────────────────────────────────────────────────
//
// Push tokens. `authenticate` only — deliberately not `requireOnboarded`: a
// call cannot arrive before onboarding is finished, but the *token* is
// available the moment the app launches, and refusing it until the profile is
// complete means the first thing a new account misses is the notification
// telling them somebody replied.

const devs = express.Router();
devs.use(authenticate);

devs.post('/', validate({ body: S.devices.register }), h(devices.register));
devs.delete('/', validate({ body: S.devices.unregister }), h(devices.unregister));

router.use('/devices', devs);

// ── Moderation ──────────────────────────────────────────────────────────────

const mod = express.Router();
mod.use(authenticate);

mod.get('/blocked', validate({ query: S.pagination }), h(moderation.listBlocked));
mod.post(
  '/block',
  writeLimiter,
  validate({ body: S.moderation.block }),
  h(moderation.block)
);
mod.delete(
  '/block/:id',
  validate({ params: S.moderation.userParam }),
  h(moderation.unblock)
);
mod.post(
  '/report',
  writeLimiter,
  validate({ body: S.moderation.report }),
  h(moderation.report)
);

router.use('/moderation', mod);

// ── Support ─────────────────────────────────────────────────────────────────
//
// The Help & Support screen's "send us a message". `authenticate` only, like
// moderation: somebody stuck half-way through onboarding is exactly who might
// need to ask for help.

const sup = express.Router();
sup.use(authenticate);

sup.post(
  '/messages',
  supportLimiter,
  validate({ body: S.support.message }),
  h(support.send)
);

router.use('/support', sup);

module.exports = router;
