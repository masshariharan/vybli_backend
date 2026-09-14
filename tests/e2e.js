'use strict';

/**
 * End-to-end walk of the whole product, against a running server.
 *
 *   node src/server.js        # terminal one
 *   npm run test:e2e          # terminal two
 *
 * Two accounts are created — an Earn Money profile and a Make Friends one —
 * and driven through the journey the app actually offers: sign up, onboard,
 * discover, connect, chat, call, get billed, get paid. It asserts on the
 * *rules*, not just on status codes: that a stranger cannot be messaged, that
 * money leaves the caller's wallet, that blocking severs a conversation.
 *
 * Not a unit-test suite. This is the integration pass that catches the things
 * mocks agree to pretend about.
 */

const BASE = process.env.API_BASE || 'http://localhost:4000/api/v1';

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    failures.push({ label, detail });
    console.log(`  ✗ ${label}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json;
  try {
    json = await res.json();
  } catch {
    json = { success: false, message: 'Non-JSON response' };
  }
  return { status: res.status, ...json };
}

const get = (p, t) => api('GET', p, { token: t });
const post = (p, t, b) => api('POST', p, { token: t, body: b });
const patch = (p, t, b) => api('PATCH', p, { token: t, body: b });
const put = (p, t, b) => api('PUT', p, { token: t, body: b });
const del = (p, t, b) => api('DELETE', p, { token: t, body: b });

/**
 * Every number this run created, so it can remove them again.
 *
 * The suite used to leave its accounts behind — a dozen or so per run, each a
 * complete profile marked online and discoverable. On a development database
 * that is also somebody's phone, they accumulate into a discovery feed made
 * entirely of people who do not exist and never answer. Setting them offline,
 * which is all the old cleanup did, hid the symptom and kept the rows.
 */
const createdPhones = [];

/** A phone number nobody else in this run will use. */
const uniquePhone = (() => {
  let n = 0;
  const base = Date.now() % 1_000_000;
  return () => {
    const phone = String(9_000_000_000 + ((base * 13 + ++n * 7919) % 999_999_999));
    createdPhones.push(phone);
    return phone;
  };
})();

/**
 * Deletes every account this run created.
 *
 * Straight to the database rather than through `DELETE /auth/account`: that
 * endpoint anonymises and tombstones by design, which is right for a person
 * leaving and wrong for a fixture — it would leave the same rows behind under
 * a different name. A test's own data should vanish completely.
 */
async function removeCreatedAccounts() {
  const { createPrismaClient } = require('../src/config/prismaClient');
  const prisma = createPrismaClient();
  try {
    // Tombstoned numbers are prefixed, so match on containment to catch an
    // account a delete test already retired.
    const rows = await prisma.user.findMany({
      where: { OR: createdPhones.map((phone) => ({ phone: { contains: phone } })) },
      select: { id: true },
    });
    if (rows.length === 0) return 0;
    const { count } = await prisma.user.deleteMany({
      where: { id: { in: rows.map((r) => r.id) } },
    });

    return count;
  } finally {
    await prisma.$disconnect();
  }
}

/** Signs up and runs the whole onboarding, returning a ready account. */
async function createAccount({ name, cityId = 'chennai', gender = 'female', age = 25 }) {
  const phone = uniquePhone();

  const requested = await post('/auth/otp/request', null, {
    dial_code: '+91',
    phone,
  });
  if (!requested.success) throw new Error(`OTP request failed: ${requested.message}`);

  const code = requested.data.dev_code;
  const verified = await post('/auth/otp/verify', null, {
    dial_code: '+91',
    phone,
    code,
  });
  if (!verified.success) throw new Error(`OTP verify failed: ${verified.message}`);

  const token = verified.data.access_token;

  await post('/onboarding/gender', token, { gender });
  await post('/onboarding/age', token, { age });
  await post('/onboarding/languages', token, { language_codes: ['en', 'ta'] });
  // Gender alone decides the role now — there is no separate mode step to
  // call. A female account lands here already flagged `isEarner`.
  await post('/onboarding/location', token, { city_id: cityId });
  await post('/onboarding/profile', token, { name, bio: `Hi, I am ${name}.` });

  if (gender === 'female') {
    // An earner needs a photo before `complete` will accept it. Identity
    // review itself happens after, manually, and has no onboarding step.
    // The client always sends a real catalog id — never a guess — but any
    // valid one does for a fixture.
    const avatars = await get('/avatars?gender=female', null);
    await put('/me/avatar', token, { avatar_id: avatars.data.avatars[0].id });
  }

  const completed = await post('/onboarding/complete', token);
  if (!completed.success) {
    throw new Error(`Onboarding complete failed: ${JSON.stringify(completed)}`);
  }

  return {
    token,
    refreshToken: verified.data.refresh_token,
    phone,
    id: completed.data.user.id,
    name,
    user: completed.data.user,
  };
}

async function run() {
  console.log(`Vybli API end-to-end — ${BASE}\n`);

  const health = await get('/health');
  if (!health.success) {
    console.error('Server is not responding. Start it with `node src/server.js`.');
    process.exit(1);
  }

  // ── Reference data ────────────────────────────────────────────────────────
  section('Reference data');

  // The language catalogue is the app's, not ours — it ships compiled into the
  // Flutter build, so there is no endpoint to serve it and this asserts the
  // absence rather than the contents.
  const langs = await get('/languages');
  check('the language catalogue is not served by the API', langs.status === 404, {
    status: langs.status,
  });

  // The city catalogue is the app's, not ours — names, states and coordinates
  // ship compiled into the Flutter build, so this asserts the absence.
  const cities = await get('/cities');
  check('the city catalogue is not served by the API', cities.status === 404, {
    status: cities.status,
  });

  // What is left: the one thing about a city only this server knows.
  const stats = await get('/cities/stats');
  check('city stats are keyed by city id', stats.success && stats.data?.counts, {
    got: stats.data,
  });
  check(
    'every counted city is a slug, and every count a number',
    Object.entries(stats.data?.counts ?? {}).every(
      ([id, n]) => /^[a-z][a-z0-9_-]*$/.test(id) && Number.isInteger(n) && n >= 0
    ),
    { counts: stats.data?.counts }
  );

  // A coordinate, never a city — which city a point is in is decided on the
  // phone. Answers with nulls rather than erroring when it cannot tell.
  const estimate = await get('/location/ip-estimate');
  check(
    'the IP estimate answers a coordinate or an honest null',
    estimate.success &&
      'lat' in estimate.data &&
      'lng' in estimate.data &&
      !('city' in estimate.data),
    { got: estimate.data }
  );

  // The resolution that used to live here.
  const nearest = await get('/cities/nearest?lat=13.0827&lng=80.2707');
  check('coordinate-to-city is no longer a server route', nearest.status === 404, {
    status: nearest.status,
  });

  // ── Auth & onboarding ─────────────────────────────────────────────────────
  section('Auth and onboarding');

  const phone = uniquePhone();
  const otp1 = await post('/auth/otp/request', null, { dial_code: '+91', phone });
  check('OTP request succeeds', otp1.success);
  check('a new number is reported as new', otp1.data?.is_existing_user === false);

  const badCode = await post('/auth/otp/verify', null, {
    dial_code: '+91',
    phone,
    code: '000000',
  });
  check('a wrong code is rejected', !badCode.success && badCode.error === 'OTP_INVALID', {
    error: badCode.error,
  });

  const signup = await post('/auth/otp/verify', null, {
    dial_code: '+91',
    phone,
    code: otp1.data.dev_code,
  });
  check('the right code signs in', signup.success);
  check('a new account is flagged as new', signup.data?.is_new_user === true);
  check(
    'onboarding starts at PHONE_VERIFIED',
    signup.data?.onboarding_status === 'PHONE_VERIFIED',
    { got: signup.data?.onboarding_status }
  );

  const t = signup.data.access_token;

  const replay = await post('/auth/otp/verify', null, {
    dial_code: '+91',
    phone,
    code: otp1.data.dev_code,
  });
  check('a consumed code cannot be replayed', !replay.success, { error: replay.error });

  const gated = await get('/users/discover', t);
  check(
    'the feed is closed until onboarding is finished',
    !gated.success && gated.error === 'ONBOARDING_INCOMPLETE',
    { error: gated.error }
  );

  const st1 = await get('/onboarding/status', t);
  check('status names the next step', st1.data?.next_step === 'gender', {
    got: st1.data?.next_step,
  });

  await post('/onboarding/gender', t, { gender: 'male' });
  const st2 = await get('/onboarding/status', t);
  check('progress advances after a step', st2.data?.status === 'GENDER_COMPLETED');

  const tooYoung = await post('/onboarding/age', t, { age: 15 });
  check(
    'under-18 is refused',
    !tooYoung.success && tooYoung.error === 'VALIDATION_ERROR',
    { error: tooYoung.error }
  );

  await post('/onboarding/age', t, { age: 28 });
  await post('/onboarding/languages', t, { language_codes: ['en', 'hi'] });

  // A code this server has never seen is a newer client's language, not a
  // fault — there is no catalogue here to contradict it, and rejecting it would
  // mean an app update could not add a language without a deploy.
  const newCode = await post('/onboarding/languages', t, {
    language_codes: ['en', 'tlh'],
  });
  check('an unfamiliar but well-formed code is stored', newCode.success, {
    error: newCode.error,
  });

  // Shape is still enforced: a display name where a code belongs is refused.
  const badLang = await post('/onboarding/languages', t, {
    language_codes: ['en', 'Klingon!'],
  });
  check('a malformed language code is refused', !badLang.success, { error: badLang.error });

  // Put the account back to what the rest of this file expects.
  await post('/onboarding/languages', t, { language_codes: ['en', 'hi'] });

  // Gender is male, so this also sets goal/isEarner to makeFriends — location
  // is the step that derives the role now; there is no separate mode step.
  await post('/onboarding/location', t, { city_id: 'chennai' });

  // Re-editing an earlier answer must not drag the user back a screen.
  await post('/onboarding/gender', t, { gender: 'male' });
  const st3 = await get('/onboarding/status', t);
  check(
    'editing an earlier step does not regress progress',
    st3.data?.status === 'MODE_SELECTED',
    { got: st3.data?.status }
  );

  await post('/onboarding/profile', t, { name: 'Rahul', bio: 'Testing Vybli.' });
  const done = await post('/onboarding/complete', t);
  check('onboarding completes', done.success && done.data?.onboarding_status === 'ONBOARDING_COMPLETED');

  // ── Two real accounts ─────────────────────────────────────────────────────
  section('Building an earner and a caller');

  const earner = await createAccount({
    name: 'Meera',
    cityId: 'chennai',
    gender: 'female',
  });
  check('an Earn Money account can be created', Boolean(earner.id));
  check('it is flagged as an earner', earner.user.is_earner === true);
  // Finishing onboarding queues the account for review; it does not verify
  // it. `isVerified` is set by an administrator in the panel and nowhere
  // else, so a fresh earner is discoverable but not yet badged.
  check('onboarding did not self-approve', earner.user.is_verified === false);

  // Distinct from the default every fixture account otherwise shares, so a
  // later assertion that a card quotes "the earner's own rate" is actually
  // discriminating rather than passing by coincidence.
  const MEERA_RATE = 25;
  {
    const { createPrismaClient } = require('../src/config/prismaClient');
    const direct = createPrismaClient();
    await direct.userProfile.update({
      where: { userId: earner.id },
      data: { voiceRatePerMinute: MEERA_RATE },
    });
    await direct.$disconnect();
  }

  const caller = await createAccount({
    name: 'Arjun',
    cityId: 'chennai',
    gender: 'male',
  });
  check('a Make Friends account can be created', Boolean(caller.id));
  check('it is not an earner', caller.user.is_earner === false);

  // Presence, so the earner is callable.
  const wentOnline = await put('/me/presence', earner.token, { status: 'online' });
  await put('/me/presence', caller.token, { status: 'online' });
  check('presence is recorded', wentOnline.data?.status === 'online', {
    got: wentOnline.data?.status,
  });

  // Setting the status it already has is a no-op that still answers with the
  // truth. The socket layer leans on this: it marks every connection online
  // unconditionally, because "is this the only socket in the room" is a
  // different question from "is this account connected" — and answering the
  // wrong one left people offline while their app sat there connected.
  const again = await put('/me/presence', earner.token, { status: 'online' });
  check('re-asserting the same presence is idempotent', again.success && again.data?.status === 'online', {
    got: again.data,
  });

  // ── Verification ──────────────────────────────────────────────────────────
  section('Verification');

  // `onboardingService.complete` queues an earner as `pending` the moment
  // onboarding finishes — there is nothing for the client to submit, only a
  // status to read.
  const statusAfterOnboarding = await get('/verification/status', earner.token);
  check(
    'status reports pending once onboarding finishes',
    statusAfterOnboarding.data?.status === 'pending',
    statusAfterOnboarding.data
  );
  check(
    'not verified yet — only an administrator can set that',
    statusAfterOnboarding.data?.is_verified === false
  );

  const nonEarnerStatus = await get('/verification/status', caller.token);
  check(
    'a Make Friends account is never queued for review',
    nonEarnerStatus.data?.status === 'not_required',
    nonEarnerStatus.data
  );

  // ── Discovery ─────────────────────────────────────────────────────────────
  section('Discovery');

  // The city picker counts members, and the two ways it used to stop doing so.
  //
  // A city with only callers in it. Nobody in Madurai is an earner, so the
  // whole city vanished from the picker while the count was narrowed to the
  // people a discovery feed would return — and two thirds of the accounts on
  // this platform are callers, so it took a lot of India with it.
  const onlyCaller = await createAccount({
    name: 'Vikram',
    cityId: 'madurai',
    gender: 'male',
  });
  check('a city can hold only callers', onlyCaller.user.is_earner === false);

  const cityCounts = await get('/cities/stats');

  // Registered, not connected.
  //
  // No account in this run has ever opened a socket, so every one of them is
  // `offline` — which is exactly the state the city picker used to disappear
  // on. It counted only people who were online, so a quiet evening emptied the
  // whole of India and there was nowhere to browse to. Somebody choosing a
  // city is choosing where to *look*, and that is a question about where
  // people have signed up.
  check(
    "an offline account still puts its city on the picker's list",
    (cityCounts.data?.counts ?? {})[earner.user?.city_id ?? 'chennai'] > 0,
    { counts: cityCounts.data?.counts }
  );

  check(
    'a city with no earners in it is still on the list',
    (cityCounts.data?.counts ?? {}).madurai > 0,
    { counts: cityCounts.data?.counts }
  );

  // Both sides of Chennai, counted once each. A membership count that silently
  // dropped one side would still pass the assertion above.
  check(
    'callers and earners are counted together',
    (cityCounts.data?.counts ?? {}).chennai >= 2,
    { chennai: (cityCounts.data?.counts ?? {}).chennai }
  );

  const feed = await get('/users/discover?scope=myCity&limit=50', caller.token);
  check('the feed returns people', feed.data?.items?.length > 0, {
    count: feed.data?.items?.length,
  });

  const found = feed.data.items.find((u) => u.id === earner.id);
  check('the earner appears in the feed', Boolean(found));
  check(
    'the card carries what the UI needs to price a call',
    found?.voice_rate_per_minute > 0 && found?.video_rate_per_minute > 0,
    { voice: found?.voice_rate_per_minute, video: found?.video_rate_per_minute }
  );
  check(
    'the payload uses the snake_case keys the Flutter model parses',
    found && 'city_id' in found && 'is_earner' in found && 'total_calls' in found
  );

  const selfInFeed = feed.data.items.some((u) => u.id === caller.id);
  check('you never appear in your own feed', !selfInFeed);

  // Discovery is symmetric by role, not one-directional: an earner's own feed
  // shows non-earners (and only non-earners), the mirror of what a non-earner
  // sees.
  const earnerFeed = await get('/users/discover?scope=allCities&limit=100', earner.token);
  check(
    'a non-earner appears in an earner\'s feed',
    earnerFeed.data?.items?.some((u) => u.id === caller.id)
  );
  check(
    'an earner\'s feed contains no other earners',
    earnerFeed.data?.items?.every((u) => u.is_earner === false)
  );

  // A card carries a price only when the viewer is the one who pays *and* the
  // person on it is the one who earns. Meera is an earner, so neither half
  // holds on her own feed and every card on it quotes zero.
  //
  // Zero is the contract, not a missing value: the app reads it as "nothing to
  // charge you" and renders the call button with no price at all
  // (`CallActionButton`, `showPrice = ratePerMinute > 0`). Quoting Meera's own
  // rate here — what this used to assert — would put "₹25/min" on a button that
  // costs her nothing, on the one screen where an earner should see no price.
  // Her own rate reaches her through `/me`, which has no viewer to discount
  // against and returns it in full.
  const callerCard = earnerFeed.data.items.find((u) => u.id === caller.id);
  check(
    'an earner is quoted no price on the cards in her own feed',
    callerCard?.voice_rate_per_minute === 0 &&
      callerCard?.video_rate_per_minute === 0,
    {
      voice: callerCard?.voice_rate_per_minute,
      video: callerCard?.video_rate_per_minute,
    }
  );

  // The other half of that rule, so the two cannot drift apart: the same
  // account reading her own profile still sees the rate she earns.
  const meeraSelf = await get('/me', earner.token);
  check(
    'but she still sees her own rate on her own profile',
    meeraSelf.data?.user?.voice_rate_per_minute === MEERA_RATE,
    { got: meeraSelf.data?.user?.voice_rate_per_minute, expected: MEERA_RATE }
  );

  // ── Friend requests ───────────────────────────────────────────────────────
  section('Friend requests');

  const toSelf = await post('/friends/requests', caller.token, { user_id: caller.id });
  check('you cannot friend yourself', !toSelf.success, { error: toSelf.error });

  const fromEarner = await post('/friends/requests', earner.token, {
    user_id: caller.id,
  });
  check(
    'an earner cannot send a friend request',
    !fromEarner.success && fromEarner.error === 'SENDER_IS_EARNER',
    { error: fromEarner.error }
  );

  const req = await post('/friends/requests', caller.token, {
    user_id: earner.id,
    message: 'Hi Meera! Would love to connect.',
  });
  check('a request to an earner is accepted', req.success, { error: req.error });
  const requestId = req.data?.request?.id;

  const dup = await post('/friends/requests', caller.token, { user_id: earner.id });
  check(
    'a duplicate request is refused',
    !dup.success && dup.error === 'FRIEND_REQUEST_EXISTS',
    { error: dup.error }
  );

  const beforeAccept = await get(`/users/${earner.id}/connection`, caller.token);
  check(
    'the sender sees requestSent',
    beforeAccept.data?.connection_status === 'requestSent',
    { got: beforeAccept.data?.connection_status }
  );

  const inbox = await get('/friends/requests?direction=incoming', earner.token);
  check('the earner sees it in their inbox', inbox.data?.items?.length === 1);

  // Messaging before acceptance is the rule the whole gate exists for.
  const convoBefore = await get(`/users/${earner.id}/conversation`, caller.token);
  check(
    'no conversation exists before acceptance',
    convoBefore.data?.conversation_id === null
  );

  const accepted = await post(`/friends/requests/${requestId}/accept`, earner.token);
  check('the request can be accepted', accepted.success);
  const conversationId = accepted.data?.conversation_id;
  check('accepting creates the conversation', Boolean(conversationId));

  const afterAccept = await get(`/users/${earner.id}/connection`, caller.token);
  check(
    'both sides are now friends',
    afterAccept.data?.connection_status === 'friends',
    { got: afterAccept.data?.connection_status }
  );

  // ── Messaging ─────────────────────────────────────────────────────────────
  section('Messaging');

  const thread = await get(`/conversations/${conversationId}`, caller.token);
  check('the thread opens', thread.success);
  check(
    'the request message became the first message',
    thread.data?.thread?.messages?.length >= 1,
    { count: thread.data?.thread?.messages?.length }
  );

  const sent = await post(`/conversations/${conversationId}/messages`, caller.token, {
    text: 'Hey! How are you?',
    client_id: 'local_1',
  });
  check('a message can be sent', sent.success);
  check('the client id is echoed for reconciliation', sent.data?.client_id === 'local_1');
  check('authorship is relative to the reader', sent.data?.message?.author === 'me');

  const earnerThread = await get(`/conversations/${conversationId}`, earner.token);
  const lastMessage = earnerThread.data?.thread?.messages?.slice(-1)[0];
  check('the recipient sees it as theirs', lastMessage?.author === 'them', {
    got: lastMessage?.author,
  });

  const empty = await post(`/conversations/${conversationId}/messages`, caller.token, {
    text: '   ',
  });
  check('an empty message is refused', !empty.success, { error: empty.error });

  // A third party must not be able to read the thread. Male, like `caller` —
  // so it also doubles below as a same-role pair for the recipient-side
  // friend-request check, and later as a second non-earner a busy `earner`
  // can still legitimately ring.
  const outsider = await createAccount({
    name: 'Karthik',
    cityId: 'mumbai',
    gender: 'male',
  });
  const peeked = await get(`/conversations/${conversationId}`, outsider.token);
  check(
    "someone else's conversation reads as not found",
    !peeked.success && peeked.error === 'CONVERSATION_NOT_FOUND',
    { error: peeked.error }
  );

  const strangerMsg = await post(
    `/conversations/${conversationId}/messages`,
    outsider.token,
    { text: 'let me in' }
  );
  check('and cannot be written to', !strangerMsg.success);

  const toNonEarner = await post('/friends/requests', caller.token, {
    user_id: outsider.id,
  });
  check(
    'a request to a non-earner is refused',
    !toNonEarner.success && toNonEarner.error === 'RECIPIENT_NOT_EARNER',
    { error: toNonEarner.error }
  );

  // Unread accounting. A fresh message is needed here because opening the
  // thread above already marked everything read — which is itself the
  // behaviour being relied on two assertions down.
  await post(`/conversations/${conversationId}/messages`, caller.token, {
    text: 'One more thing…',
  });
  const unread = await get('/conversations/unread', earner.token);
  check('an unread message is counted', unread.data?.unread_messages > 0, {
    got: unread.data?.unread_messages,
  });

  await post(`/conversations/${conversationId}/read`, earner.token);
  const unreadAfter = await get('/conversations/unread', earner.token);
  check(
    'reading the thread clears the badge',
    unreadAfter.data?.unread_messages === 0,
    { got: unreadAfter.data?.unread_messages }
  );

  // ── Privacy: Allow Messages ───────────────────────────────────────────────
  section('Privacy — Allow Messages');

  await patch('/me/settings/privacy', earner.token, { allow_messages: false });

  const blockedByPrivacy = await post(
    `/conversations/${conversationId}/messages`,
    caller.token,
    { text: 'still there?' }
  );
  check(
    'messaging someone who turned it off is refused',
    !blockedByPrivacy.success &&
      blockedByPrivacy.error === 'MESSAGING_DISABLED_PEER',
    { error: blockedByPrivacy.error }
  );

  const theirList = await get('/conversations', earner.token);
  check(
    'their own chat list reports messaging off rather than erroring',
    theirList.success && theirList.data?.messaging_disabled === true
  );

  await patch('/me/settings/privacy', earner.token, { allow_messages: true });
  const restored = await post(
    `/conversations/${conversationId}/messages`,
    caller.token,
    { text: 'back on' }
  );
  check('turning it back on restores messaging', restored.success);

  // ── Privacy: discovery visibility ─────────────────────────────────────────
  section('Privacy — profile visibility');

  await patch('/me/settings/privacy', earner.token, {
    profile_visible_to_everyone: false,
  });
  const hiddenFeed = await get('/users/discover?scope=allCities&limit=100', outsider.token);
  check(
    'a hidden profile leaves discovery',
    !hiddenFeed.data?.items?.some((u) => u.id === earner.id)
  );

  const strangerLookup = await get(`/users/${earner.id}`, outsider.token);
  check(
    'and is not reachable by direct link for a stranger',
    !strangerLookup.success,
    { error: strangerLookup.error }
  );

  const friendLookup = await get(`/users/${earner.id}`, caller.token);
  check('but stays visible to an existing friend', friendLookup.success);

  await patch('/me/settings/privacy', earner.token, {
    profile_visible_to_everyone: true,
  });

  // ── Privacy: presence and city ────────────────────────────────────────────
  section('Privacy — presence and city');

  await patch('/me/settings/privacy', earner.token, { show_online_status: false });
  const hiddenPresence = await get(`/users/${earner.id}`, caller.token);
  check(
    'hidden presence reads as offline to others',
    hiddenPresence.data?.user?.status === 'offline',
    { got: hiddenPresence.data?.user?.status }
  );

  const ownView = await get('/me', earner.token);
  check(
    'but the owner still sees their real status',
    ownView.data?.user?.status === 'online',
    { got: ownView.data?.user?.status }
  );

  await patch('/me/settings/privacy', earner.token, { show_online_status: true });

  await patch('/me/settings/privacy', earner.token, { show_city_on_profile: false });
  const hiddenCity = await get(`/users/${earner.id}`, caller.token);
  check(
    'a hidden city is absent from the payload, not blanked client-side',
    hiddenCity.data?.user?.city_id === '' && !('city_name' in hiddenCity.data.user),
    { got: hiddenCity.data?.user?.city_id }
  );
  await patch('/me/settings/privacy', earner.token, { show_city_on_profile: true });

  // ── Privacy: call types ───────────────────────────────────────────────────
  section('Privacy — call types');

  await patch('/me/settings/privacy', earner.token, { allow_video_calls: false });
  const profileAfter = await get(`/users/${earner.id}`, caller.token);
  check(
    'switching video off updates the profile others see',
    profileAfter.data?.user?.video_enabled === false,
    { got: profileAfter.data?.user?.video_enabled }
  );

  const videoBlocked = await post('/calls', caller.token, {
    user_id: earner.id,
    type: 'video',
  });
  check(
    'and refuses a video call',
    !videoBlocked.success && videoBlocked.error === 'CALL_TYPE_DISABLED',
    { error: videoBlocked.error }
  );
  await patch('/me/settings/privacy', earner.token, { allow_video_calls: true });

  // ── Wallet ────────────────────────────────────────────────────────────────
  section('Wallet');

  const packages = await get('/wallet/packages', caller.token);
  check('recharge packages come from the database', packages.data?.packages?.length === 5);

  const wallet0 = await get('/wallet', caller.token);
  check('a new wallet starts empty', wallet0.data?.wallet?.balance === 0, {
    got: wallet0.data?.wallet?.balance,
  });

  const bought = await post('/wallet/purchase', caller.token, {
    package_id: 'pkg_1000',
  });
  // With PAYMENT_PROVIDER=none this is the development credit path. Against a
  // deployment with Google Play Billing wired in it would refuse with
  // PAYMENTS_UNAVAILABLE without a purchase_token to verify, which is the
  // point of the flag.
  check('a purchase succeeds', bought.success, { error: bought.error });
  check('the bonus is included', bought.data?.amount_added === 1100, {
    got: bought.data?.amount_added,
  });

  const wallet1 = await get('/wallet', caller.token);
  check('the balance reflects the purchase', wallet1.data?.wallet?.balance === 1100, {
    got: wallet1.data?.wallet?.balance,
  });

  const ledger = await get('/wallet/transactions', caller.token);
  check(
    'the purchase is on the ledger',
    ledger.data?.items?.some((t) => t.kind === 'purchase' && t.amount === 1100)
  );

  const earnerLedger = await get('/wallet/transactions', earner.token);
  check('an earner sees earning rows', earnerLedger.success);
  const friendsWallet = await get('/wallet', caller.token);
  check(
    'a friends account is shown zero earnings rather than nulls',
    friendsWallet.data?.wallet?.total_earnings === 0 &&
      friendsWallet.data?.wallet?.is_earner === false
  );

  const earnerOnly = await get('/wallet/earnings', caller.token);
  check(
    'earnings are closed to a non-earner',
    !earnerOnly.success && earnerOnly.error === 'NOT_EARNER_ACCOUNT',
    { error: earnerOnly.error }
  );

  // ── UPI account and withdrawal ───────────────────────────────────────────
  section('UPI account and withdrawal');

  const beforeLink = await get('/wallet/upi-account', earner.token);
  check(
    'no UPI account linked yet',
    beforeLink.success && beforeLink.data?.upi_account?.linked === false
  );

  const unverifiedWithdraw = await post('/wallet/withdraw', earner.token, {});
  check(
    'withdrawal is refused before verification',
    !unverifiedWithdraw.success &&
      unverifiedWithdraw.error === 'WITHDRAWAL_REQUIRES_VERIFICATION',
    { error: unverifiedWithdraw.error }
  );

  // Only an administrator's decision sets this in the real app — flipped
  // directly here since driving the whole admin-panel login is not what this
  // test is about.
  const { createPrismaClient } = require('../src/config/prismaClient');
  const direct = createPrismaClient();
  await direct.userProfile.update({
    where: { userId: earner.id },
    data: { isVerified: true, verificationStatus: 'verified', verifiedAt: new Date() },
  });

  const noAccountWithdraw = await post('/wallet/withdraw', earner.token, {});
  check(
    'withdrawal is refused with no UPI ID linked',
    !noAccountWithdraw.success &&
      noAccountWithdraw.error === 'WITHDRAWAL_REQUIRES_UPI_ID',
    { error: noAccountWithdraw.error }
  );

  const badUpi = await put('/wallet/upi-account', earner.token, {
    upi_id: 'not-a-upi-id',
  });
  check('an invalid UPI ID is refused', !badUpi.success, { error: badUpi.error });

  const linked = await put('/wallet/upi-account', earner.token, {
    upi_id: '9876543210@okhdfcbank',
  });
  check('a UPI ID can be linked', linked.success, { error: linked.error });
  check(
    'the UPI ID comes back as linked',
    linked.data?.upi_account?.upi_id === '9876543210@okhdfcbank',
    { got: linked.data?.upi_account }
  );

  const afterLink = await get('/wallet/upi-account', earner.token);
  check(
    'the linked account persists',
    afterLink.data?.upi_account?.linked === true &&
      afterLink.data?.upi_account?.upi_id === '9876543210@okhdfcbank'
  );

  const readyWithdraw = await post('/wallet/withdraw', earner.token, {});
  check(
    'withdrawal is no longer blocked on verification or UPI ID',
    readyWithdraw.error !== 'WITHDRAWAL_REQUIRES_UPI_ID' &&
      readyWithdraw.error !== 'WITHDRAWAL_REQUIRES_VERIFICATION',
    { success: readyWithdraw.success, error: readyWithdraw.error }
  );

  await direct.$disconnect();

  // ── VIP ───────────────────────────────────────────────────────────────────
  // A dedicated account — the shared `caller` wallet's balance is asserted on
  // an exact figure later (the per-minute call charge), and crediting a VIP
  // bonus into it would throw that off by the bonus amount.
  section('VIP');

  const vipUser = await createAccount({ name: 'VIP Tester', gender: 'male' });

  const plans = await get('/wallet/vip/plans', vipUser.token);
  check('VIP plans come from the database', plans.data?.plans?.length === 3, {
    got: plans.data?.plans?.length,
  });
  const plan2m = plans.data?.plans?.find((p) => p.id === 'vip_2m');
  check('the 2-month plan is flagged best', plan2m?.is_best === true, plan2m);

  const boughtVip = await post('/wallet/vip/purchase', vipUser.token, {
    plan_id: 'vip_2m',
  });
  check('a VIP purchase succeeds', boughtVip.success, { error: boughtVip.error });
  check('the bonus is reported', boughtVip.data?.bonus_inr === 350, {
    got: boughtVip.data?.bonus_inr,
  });
  check(
    'the purchase returns an expiry roughly 60 days out',
    Math.abs(
      new Date(boughtVip.data?.vip_expires_at) - Date.now() - 60 * 86_400_000
    ) < 60_000
  );

  const walletAfterVip = await get('/wallet', vipUser.token);
  check(
    'the bonus landed in the wallet',
    walletAfterVip.data?.wallet?.balance === 350,
    { got: walletAfterVip.data?.wallet?.balance }
  );
  check(
    'the wallet reports the same VIP expiry',
    walletAfterVip.data?.wallet?.vip_expires_at === boughtVip.data?.vip_expires_at
  );

  const vipLedger = await get('/wallet/transactions', vipUser.token);
  check(
    'the VIP purchase is on the ledger',
    vipLedger.data?.items?.some(
      (t) => t.title === 'VIP membership' && t.amount === 350
    )
  );

  const secondVip = await post('/wallet/vip/purchase', vipUser.token, {
    plan_id: 'vip_1m',
  });
  check(
    'a second purchase extends the membership rather than resetting it',
    new Date(secondVip.data?.vip_expires_at) > new Date(boughtVip.data?.vip_expires_at),
    { before: boughtVip.data?.vip_expires_at, after: secondVip.data?.vip_expires_at }
  );

  const missingPlan = await post('/wallet/vip/purchase', vipUser.token, {
    plan_id: 'not_a_real_plan',
  });
  check(
    'an unknown plan id is rejected',
    !missingPlan.success && missingPlan.error === 'PLAN_NOT_FOUND',
    { error: missingPlan.error }
  );

  // ── Calls ─────────────────────────────────────────────────────────────────
  section('Health');

  {
    const health = await get('/health');
    check('health reports ok', health.success && health.data.status === 'ok', health.message);
    // The check has to actually reach the database. A health endpoint that
    // answers `ok` while Postgres is gone keeps a broken server in a load
    // balancer's rotation, serving 500s behind a green light.
    check(
      'health verifies the database, not just the process',
      health.data.database === 'ok' && typeof health.data.latency_ms === 'number',
      JSON.stringify(health.data)
    );
  }

  section('Avatars');

  {
    const catalog = await get('/avatars');
    check('the avatar catalog loads', catalog.success && catalog.data.total > 0, catalog.data);

    const maleOnly = await get('/avatars?gender=male');
    check(
      'a gender filter returns only that gender',
      maleOnly.success && maleOnly.data.avatars.every((a) => a.gender === 'male'),
      maleOnly.data
    );

    const [firstMale, secondMale] = maleOnly.data.avatars;

    // Male: a non-earner has no photo requirement, so this account starts
    // with nothing set — an earner would already have one from onboarding.
    const picker = await createAccount({ name: 'Avatar Tester', gender: 'male' });

    const before = await get('/me', picker.token);
    check(
      'a new profile has no avatar',
      before.success && before.data.user.avatar_url === null,
      JSON.stringify(before.data?.user?.avatar_url)
    );

    const picked = await put('/me/avatar', picker.token, { avatar_id: firstMale.id });
    check(
      'picking a catalog avatar sets it',
      picked.success && picked.data.user.avatar_url === firstMale.url,
      picked.data?.user?.avatar_url
    );

    // The bytes are actually retrievable at that URL.
    const origin = BASE.replace(/\/api\/v1$/, '');
    const fetched = await fetch(`${origin}${firstMale.url}`);
    check('the avatar image is actually served', fetched.ok, fetched.status);

    // The whole point: two accounts choosing the same avatar share the exact
    // same URL — nothing was duplicated or uploaded on either one's behalf.
    const other = await createAccount({ name: 'Avatar Sharer', gender: 'male' });
    const otherPicked = await put('/me/avatar', other.token, { avatar_id: firstMale.id });
    check(
      'a second account picking the same avatar gets the identical url',
      otherPicked.success && otherPicked.data.user.avatar_url === picked.data.user.avatar_url,
      otherPicked.data?.user?.avatar_url
    );

    // Switching is just picking a different id — nothing to delete, nothing
    // left behind from the previous choice.
    const switched = await put('/me/avatar', picker.token, { avatar_id: secondMale.id });
    check(
      'switching avatars updates the url',
      switched.success && switched.data.user.avatar_url === secondMale.url,
      switched.data?.user?.avatar_url
    );

    const bogus = await put('/me/avatar', picker.token, { avatar_id: 'not-a-real-avatar' });
    check(
      'an id outside the catalog is refused',
      !bogus.success && bogus.status === 404,
      `status ${bogus.status}: ${bogus.message}`
    );

    // The refusal must not have disturbed the avatar already set.
    const intact = await get('/me', picker.token);
    check(
      'a refused pick leaves the existing avatar alone',
      intact.data.user.avatar_url === secondMale.url,
      intact.data?.user?.avatar_url
    );

    // There is no writable `avatar_url` or `avatar_id` field on PATCH /me —
    // picking one is the only way, and it is checked against the catalog.
    const injected = await patch('/me', picker.token, {
      avatar_url: 'https://example.com/someone-elses-photo.jpg',
    });
    const after = await get('/me', picker.token);
    check(
      'avatar_url cannot be set through PATCH /me',
      after.data.user.avatar_url === secondMale.url,
      `patch said ${injected.status}, avatar is now ${after.data?.user?.avatar_url}`
    );

    // Signed out, this is nobody's avatar to change.
    const anon = await put('/me/avatar', null, { avatar_id: firstMale.id });
    check('an anonymous pick is refused', anon.status === 401, `status ${anon.status}`);
  }

  section('Calls and billing');

  const rate = profileAfter.data.user.voice_rate_per_minute;

  const call = await post('/calls', caller.token, {
    user_id: earner.id,
    type: 'voice',
  });
  check('a call can be placed', call.success, { error: call.error });
  const callId = call.data?.call?.id;
  check('it starts ringing', call.data?.call?.status === 'ringing');
  check('the rate is snapshotted onto the call', call.data?.call?.rate_per_minute === rate);

  const secondCall = await post('/calls', outsider.token, {
    user_id: earner.id,
    type: 'voice',
  });
  check(
    'a second caller gets a busy signal',
    !secondCall.success && secondCall.error === 'CALLEE_BUSY',
    { error: secondCall.error }
  );

  // ── Media credentials ──────────────────────────────────────────────────
  //
  // Skipped when LiveKit is not configured, which is a legitimate development
  // state. Production refuses to boot without it, so these run in CI.
  const liveStatus = await get('/livekit/status', caller.token);
  const mediaOn = liveStatus.data?.configured === true;
  if (!mediaOn) {
    console.log('  · LiveKit not configured — skipping media credential checks');
  }

  if (mediaOn) {
    const media = call.data?.call?.livekit;
    check('the caller is handed media credentials with the call', Boolean(media), {
      got: media,
    });
    check('they name the room for this call', media?.room === `call_${callId}`, {
      got: media?.room,
    });
    check('and point at the LiveKit server', String(media?.url || '').startsWith('ws'), {
      got: media?.url,
    });

    // The grant has to be narrow. A token that let a voice caller publish
    // video would be a paid feature given away, and one scoped to the wrong
    // room would be a way into somebody else's conversation.
    const grant = JSON.parse(
      Buffer.from(String(media?.token || '..').split('.')[1] || '', 'base64').toString() || '{}'
    );
    check('the token is scoped to that room only', grant?.video?.room === `call_${callId}`, {
      got: grant?.video?.room,
    });
    check('it is issued to the caller', grant?.sub === caller.id, { got: grant?.sub });
    check(
      'a voice call may publish the microphone and nothing else',
      Array.isArray(grant?.video?.canPublishSources) &&
        grant.video.canPublishSources.length === 1 &&
        grant.video.canPublishSources[0] === 'microphone',
      { got: grant?.video?.canPublishSources }
    );
    check('and it expires', typeof grant?.exp === 'number' && grant.exp > 0);
  }

  const answered = await post(`/calls/${callId}/accept`, earner.token);
  check('the callee can answer', answered.success, { error: answered.error });
  check('the call is connected', answered.data?.call?.status === 'connected');

  if (mediaOn) {
    const calleeMedia = answered.data?.call?.livekit;
    check('the callee is handed their own credentials', Boolean(calleeMedia));
    const calleeGrant = JSON.parse(
      Buffer.from(String(calleeMedia?.token || '..').split('.')[1] || '', 'base64').toString() ||
        '{}'
    );
    // Per-viewer, never broadcast: the caller's token would let the callee
    // publish as the caller.
    check('issued to the callee, not the caller', calleeGrant?.sub === earner.id, {
      got: calleeGrant?.sub,
    });
    check(
      'into the same room',
      calleeGrant?.video?.room === `call_${callId}`,
      { got: calleeGrant?.video?.room }
    );

    const refreshed = await post(`/calls/${callId}/token`, caller.token);
    check('a long call can refresh its token', refreshed.success && Boolean(refreshed.data?.livekit?.token), {
      error: refreshed.error,
    });

    const stolen = await post(`/calls/${callId}/token`, outsider.token);
    check(
      'someone not on the call cannot get one',
      !stolen.success && stolen.error === 'NOT_CALL_PARTICIPANT',
      { error: stolen.error }
    );
  }

  const walletDuring = await get('/wallet', caller.token);
  check(
    'the first minute is charged the moment it connects',
    walletDuring.data?.wallet?.balance === 1100 - rate,
    { expected: 1100 - rate, got: walletDuring.data?.wallet?.balance }
  );

  const active = await get('/calls/active', caller.token);
  check('an in-progress call can be recovered after a restart', active.data?.call?.id === callId);

  const ended = await post(`/calls/${callId}/end`, caller.token, { reason: 'hungUp' });
  check('the call can be ended', ended.success);
  check(
    'the summary reports what was actually charged',
    ended.data?.summary?.amount_spent === rate,
    { got: ended.data?.summary?.amount_spent }
  );

  if (mediaOn) {
    check(
      'a finished call carries no credentials',
      ended.data?.call?.livekit === null,
      { got: ended.data?.call?.livekit }
    );

    // The webhook ends calls, and LiveKit calls it with no user session — so
    // the signature is the only thing guarding it.
    const unsigned = await fetch(`${BASE}/livekit/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/webhook+json' },
      body: JSON.stringify({ event: 'room_finished', room: { name: `call_${callId}` } }),
    });
    check('an unsigned webhook is refused', unsigned.status === 401, {
      status: unsigned.status,
    });

    const forged = await fetch(`${BASE}/livekit/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/webhook+json',
        Authorization: 'not-a-real-signature',
      },
      body: JSON.stringify({ event: 'room_finished', room: { name: `call_${callId}` } }),
    });
    check('and so is a forged one', forged.status === 401, { status: forged.status });
  }

  const history = await get('/calls/history', caller.token);
  check('the call appears in history', history.data?.items?.length > 0);
  const row = history.data.items[0];
  check('history is shaped for the Recent screen', row?.user_name && row?.direction === 'outgoing');
  check('the cost is on the row', row?.amount_spent === rate, { got: row?.amount_spent });

  const earnerHistory = await get('/calls/history', earner.token);
  const earnerRow = earnerHistory.data?.items?.[0];
  check(
    'the same call reads as incoming for the other side',
    earnerRow?.direction === 'incoming',
    { got: earnerRow?.direction }
  );
  check('and shows an earning rather than a cost', earnerRow?.earned_rupees > 0, {
    got: earnerRow?.earned_rupees,
  });

  const earnerWallet = await get('/wallet', earner.token);
  check(
    'the earning lands in the pending balance',
    earnerWallet.data?.wallet?.pending_balance > 0,
    { got: earnerWallet.data?.wallet?.pending_balance }
  );

  const rated = await post(`/calls/${callId}/rate`, caller.token, { rating: 5 });
  check('a finished call can be rated', rated.success);

  const rerate = await post(`/calls/${callId}/rate`, earner.token, { rating: 1 });
  check('only the caller can rate', !rerate.success, { error: rerate.error });

  // ── Roles are symmetric ──────────────────────────────────────────────────
  section('Reversed direction and random match');

  // The earner calling out, not just being called: she still earns, he still
  // pays — a role, not a position.
  const reversedRate = MEERA_RATE;
  const reversedCall = await post('/calls', earner.token, {
    user_id: caller.id,
    type: 'voice',
  });
  check('an earner can call out', reversedCall.success, { error: reversedCall.error });
  const reversedId = reversedCall.data?.call?.id;
  const reversedAccepted = await post(`/calls/${reversedId}/accept`, caller.token);
  check('the non-earner answers', reversedAccepted.success, { error: reversedAccepted.error });
  const reversedEnded = await post(`/calls/${reversedId}/end`, caller.token, {
    reason: 'hungUp',
  });
  // Arjun (non-earner) is the one ending it here, and he is the payer
  // regardless of who placed the call — so his own summary shows what he
  // spent, not zero.
  check(
    'the non-earner\'s own summary shows what he spent',
    reversedEnded.data?.summary?.amount_spent === reversedRate,
    { got: reversedEnded.data?.summary }
  );

  const reversedCallerHistory = await get('/calls/history', caller.token);
  const reversedRow = reversedCallerHistory.data?.items?.find((r) => r.id === reversedId);
  check(
    'the non-earner pays even when the earner placed the call',
    reversedRow?.amount_spent === reversedRate,
    { got: reversedRow }
  );

  const reversedEarnerHistory = await get('/calls/history', earner.token);
  const reversedEarnerRow = reversedEarnerHistory.data?.items?.find((r) => r.id === reversedId);
  check(
    'the earner earns even on a call she placed herself',
    reversedEarnerRow?.earned_rupees > 0,
    { got: reversedEarnerRow }
  );

  const maleRandom = await post('/users/random-match', caller.token, {
    scope: 'allCities',
    type: 'voice',
  });
  check(
    'a male requesting a random match is offered an earner',
    maleRandom.success && maleRandom.data?.user?.is_earner === true,
    { error: maleRandom.error, got: maleRandom.data?.user }
  );

  const femaleRandom = await post('/users/random-match', earner.token, {
    scope: 'allCities',
    type: 'voice',
  });
  check(
    'a female requesting a random match is offered a non-earner',
    femaleRandom.success && femaleRandom.data?.user?.is_earner === false,
    { error: femaleRandom.error, got: femaleRandom.data?.user }
  );
  check(
    'her random match quotes her own rate, not his',
    femaleRandom.data?.rate_per_minute === MEERA_RATE,
    { got: femaleRandom.data?.rate_per_minute }
  );

  const sameRoleCall = await post('/calls', caller.token, {
    user_id: outsider.id,
    type: 'voice',
  });
  check(
    'two non-earners cannot call each other',
    !sameRoleCall.success && sameRoleCall.error === 'CALL_ROLE_MISMATCH',
    { error: sameRoleCall.error }
  );

  // Insufficient funds.
  section('Running out of balance');

  const brokeUser = await createAccount({
    name: 'Skint',
    cityId: 'chennai',
    gender: 'male',
  });
  await put('/me/presence', brokeUser.token, { status: 'online' });

  const noBalance = await post('/calls', brokeUser.token, {
    user_id: earner.id,
    type: 'voice',
  });
  check(
    'a call is refused when the balance cannot cover a minute',
    !noBalance.success && noBalance.error === 'INSUFFICIENT_BALANCE',
    { error: noBalance.error }
  );
  check('and the error says what is needed', noBalance.details?.required === rate, {
    details: noBalance.details,
  });

  // The other direction: when the *earner* calls a broke non-earner, the call
  // still rings — his empty wallet is his business, not a reason to keep her
  // from dialling, and not hers to be told. It only surfaces when he tries
  // to answer, and it is put to him, not her.
  const earnerCallsBroke = await post('/calls', earner.token, {
    user_id: brokeUser.id,
    type: 'voice',
  });
  check(
    'an earner calling a broke non-earner still rings',
    earnerCallsBroke.success && earnerCallsBroke.data?.call?.status === 'ringing',
    { error: earnerCallsBroke.error }
  );
  const brokeCallId = earnerCallsBroke.data?.call?.id;

  const brokeAccept = await post(`/calls/${brokeCallId}/accept`, brokeUser.token);
  check(
    'he cannot answer without enough balance',
    !brokeAccept.success && brokeAccept.error === 'INSUFFICIENT_BALANCE',
    { error: brokeAccept.error }
  );

  const afterBrokeAttempt = await get('/calls/history', earner.token);
  const brokeRow = afterBrokeAttempt.data?.items?.find((r) => r.id === brokeCallId);
  check(
    'the call ended rather than connecting for free',
    brokeRow?.status === 'ended',
    { got: brokeRow }
  );

  // ── Blocking ──────────────────────────────────────────────────────────────
  section('Blocking');

  const blockRes = await post('/moderation/block', caller.token, { user_id: earner.id });
  check('a user can be blocked', blockRes.success);

  const afterBlock = await get(`/users/${earner.id}/connection`, caller.token);
  check(
    'blocking collapses the relationship to none',
    afterBlock.data?.connection_status === 'none',
    { got: afterBlock.data?.connection_status }
  );

  const blockedMsg = await post(
    `/conversations/${conversationId}/messages`,
    caller.token,
    { text: 'hello?' }
  );
  check('a blocked person cannot be messaged', !blockedMsg.success, {
    error: blockedMsg.error,
  });

  const blockedCall = await post('/calls', caller.token, {
    user_id: earner.id,
    type: 'voice',
  });
  check('nor called', !blockedCall.success && blockedCall.error === 'BLOCKED', {
    error: blockedCall.error,
  });

  const blockedFeed = await get('/users/discover?scope=allCities&limit=100', caller.token);
  check(
    'and disappears from discovery',
    !blockedFeed.data?.items?.some((u) => u.id === earner.id)
  );

  const chatsAfterBlock = await get('/conversations', caller.token);
  check(
    'the conversation leaves the chat list',
    !chatsAfterBlock.data?.items?.some((t) => t.id === conversationId)
  );

  const blockedList = await get('/moderation/blocked', caller.token);
  check('the blocked list shows them', blockedList.data?.items?.length === 1);

  await del(`/moderation/block/${earner.id}`, caller.token);
  const afterUnblock = await get('/moderation/blocked', caller.token);
  check('unblocking removes them from the list', afterUnblock.data?.items?.length === 0);

  // ── Reporting ─────────────────────────────────────────────────────────────
  section('Reporting');

  const report = await post('/moderation/report', outsider.token, {
    user_id: earner.id,
    reason: 'Spam',
    details: 'Sent advertising links.',
    also_block: true,
  });
  check('a report can be filed', report.success);
  check('report-and-block works in one call', report.data?.blocked === true);

  // ── Notifications ─────────────────────────────────────────────────────────
  section('Notifications');

  const notifs = await get('/notifications', earner.token);
  check('notifications were recorded', notifs.data?.items?.length > 0, {
    count: notifs.data?.items?.length,
  });
  check(
    'the friend request produced one',
    notifs.data?.items?.some((n) => n.kind === 'friendRequest')
  );

  const count = await get('/notifications/unread-count', earner.token);
  check('the unread count is exposed', count.data?.unread_count >= 0);

  await post('/notifications/read-all', earner.token);
  const afterRead = await get('/notifications/unread-count', earner.token);
  check('marking all read zeroes it', afterRead.data?.unread_count === 0);

  // ── Settings ──────────────────────────────────────────────────────────────
  section('Settings');

  // Sending both ends at once with them inverted is a client bug worth
  // reporting, not silently repairing — the user asked for something
  // impossible and should be told.
  const inverted = await patch('/me/settings/discovery', caller.token, {
    min_age: 30,
    max_age: 25,
  });
  check(
    'an explicitly inverted age range is rejected',
    !inverted.success && inverted.error === 'VALIDATION_ERROR',
    { error: inverted.error }
  );

  // A *partial* update is different: the stored other end is not the user's
  // doing, so the service reconciles rather than refusing.
  await patch('/me/settings/discovery', caller.token, { min_age: 20, max_age: 40 });
  const partial = await patch('/me/settings/discovery', caller.token, { min_age: 50 });
  check(
    'a partial update that would invert the range is reconciled',
    partial.success &&
      partial.data?.discovery?.min_age <= partial.data?.discovery?.max_age,
    { got: partial.data?.discovery }
  );

  await post('/me/settings/discovery/reset', caller.token);
  const reset = await get('/me/settings/discovery', caller.token);
  check(
    'reset restores the defaults',
    reset.data?.discovery?.min_age === 18 && reset.data?.discovery?.max_age === 45
  );

  const notifSettings = await patch('/me/settings/notifications', caller.token, {
    promotions: true,
  });
  check('notification settings persist', notifSettings.data?.notifications?.promotions === true);

  // ── Cleanup ───────────────────────────────────────────────────────────────
  // Runs before the session tests, which revoke these tokens.
  //
  // These accounts were marked online to make them callable and have no socket
  // behind them. Left that way they sit in every feed as people who never
  // answer — untidy, and on a shared database enough to break the next run
  // that reasonably assumes a discoverable user will pick up.
  section('Cleanup');

  const createdAccounts = [earner, caller, outsider, brokeUser];
  let cleaned = 0;
  for (const account of createdAccounts) {
    const result = await put('/me/presence', account.token, { status: 'offline' });
    if (result.success) cleaned += 1;
  }
  check('test accounts are left offline', cleaned === createdAccounts.length, {
    cleaned,
    of: createdAccounts.length,
  });

  // ── Tokens ────────────────────────────────────────────────────────────────
  section('Sessions');

  // Its own account, deliberately.
  //
  // These checks *end* the session they run on — rotating the refresh token
  // retires the one before it, and the logout below retires the lot — and an
  // access token is now refused the moment its session is over. Run against
  // `caller`, that left every later section holding a token revoked
  // underneath it. It only ever appeared to work because the access token
  // used to ignore revocation entirely, which is the hole this closes.
  const sessionAccount = await createAccount({
    name: 'Session Tester',
    gender: 'male',
  });

  const refreshed = await post('/auth/refresh', null, {
    refresh_token: sessionAccount.refreshToken,
  });
  check('a refresh token yields a new pair', refreshed.success);
  check(
    'the refresh token is rotated',
    refreshed.data?.refresh_token !== sessionAccount.refreshToken
  );

  const reuse = await post('/auth/refresh', null, {
    refresh_token: sessionAccount.refreshToken,
  });
  check('the old refresh token is dead after rotation', !reuse.success, {
    error: reuse.error,
  });

  // The access token from the retired session goes with it. Tokens are
  // verified by signature, so this one is still perfectly well formed and
  // unexpired — what stops it is that it names a session that is over.
  const preRotation = await get('/me', sessionAccount.token);
  check(
    'an access token outlives its own session no longer',
    !preRotation.success && preRotation.status === 401,
    { status: preRotation.status, error: preRotation.error }
  );

  const noToken = await get('/me');
  check('an unauthenticated request is refused', !noToken.success && noToken.status === 401);

  const junkToken = await get('/me', 'not-a-real-token');
  check('a forged token is refused', !junkToken.success && junkToken.status === 401);

  const newToken = refreshed.data.access_token;
  check('the rotated access token works', (await get('/me', newToken)).success);

  await post('/auth/logout', newToken, { all_devices: true });
  const afterLogout = await post('/auth/refresh', null, {
    refresh_token: refreshed.data.refresh_token,
  });
  check('logging out kills the session', !afterLogout.success, { error: afterLogout.error });
  const afterLogoutMe = await get('/me', newToken);
  check(
    'and the access token it was holding stops working too',
    !afterLogoutMe.success && afterLogoutMe.status === 401,
    { status: afterLogoutMe.status }
  );

  // ── Account deletion ─────────────────────────────────────────────────────
  // `caller`'s session tests just finished above, so its account is free to
  // delete for real without disturbing anything earlier in the run.
  section('Account deletion');

  // Blocking earlier dropped the friendship — blocking always does — so it
  // needs rebuilding before `earner` can reply. `caller` is the only side
  // allowed to send the request (an earner can't, per "Friend requests"
  // above), and accepting the same pair again is expected to hand back the
  // same conversation rather than a second one.
  const reRequest = await post('/friends/requests', caller.token, { user_id: earner.id });
  check('the friendship can be rebuilt after blocking', reRequest.success, {
    error: reRequest.error,
  });
  const reAccept = await post(
    `/friends/requests/${reRequest.data?.request?.id}/accept`,
    earner.token
  );
  check(
    'accepting it again returns the same conversation as before',
    reAccept.data?.conversation_id === conversationId,
    { got: reAccept.data?.conversation_id, expected: conversationId }
  );

  // A reply, so the conversation has something from *both* sides — deleting
  // `caller` should blank only the words that were theirs.
  const earnerReply = await post(`/conversations/${conversationId}/messages`, earner.token, {
    text: 'Good, you?',
  });
  check('the reply needed for setup below actually sent', earnerReply.success, {
    error: earnerReply.error,
  });

  // A report naming `caller`, filed by someone else — exactly the kind of
  // record another account still needs after the one it is about is gone.
  const reportOnCaller = await post('/moderation/report', outsider.token, {
    user_id: caller.id,
    reason: 'Spam',
    details: 'Kept messaging after being asked to stop.',
  });
  check('a report naming the account can still be filed', reportOnCaller.success, {
    error: reportOnCaller.error,
  });

  const beforeDelete = await get('/me', caller.token);
  check('the account is reachable before deletion', beforeDelete.success);

  const deleted = await del('/auth/account', caller.token, { reason: 'e2e test' });
  check('deleting the account succeeds', deleted.success, { error: deleted.error });

  const afterDelete = await get('/me', caller.token);
  check(
    'the token stops working once the account is deleted',
    !afterDelete.success && afterDelete.status === 401,
    { status: afterDelete.status }
  );

  // Everything past here reads the database directly — deletion just revoked
  // the one token that would otherwise let the API answer for itself.
  {
    const { createPrismaClient } = require('../src/config/prismaClient');
    const db = createPrismaClient();
    try {
      const row = await db.user.findUnique({ where: { id: caller.id } });
      check('the row is tombstoned, not gone', Boolean(row));
      check('its status is deleted', row?.status === 'deleted');
      check('the phone is released for a future sign-up', row?.phone?.startsWith('deleted_'), {
        got: row?.phone,
      });

      const wallet = await db.wallet.findUnique({ where: { userId: caller.id } });
      check('the wallet is gone', wallet === null);

      const sessions = await db.userSession.findMany({ where: { userId: caller.id } });
      check('every session row is gone, not just revoked', sessions.length === 0, {
        remaining: sessions.length,
      });

      const languages = await db.userLanguage.findMany({ where: { userId: caller.id } });
      check('language preferences are gone', languages.length === 0);

      const theirMessages = await db.message.findMany({
        where: { conversationId, senderId: caller.id },
      });
      check(
        'their own messages are blanked, not deleted',
        theirMessages.length > 0 &&
          theirMessages.every((m) => m.text === '' && m.deletedAt !== null),
        { count: theirMessages.length }
      );

      const peerMessages = await db.message.findMany({
        where: { conversationId, senderId: earner.id },
      });
      check(
        "the other side's own messages survive untouched",
        peerMessages.length > 0 &&
          peerMessages.every((m) => m.text.length > 0 && m.deletedAt === null),
        { count: peerMessages.length }
      );

      const conversation = await db.conversation.findUnique({ where: { id: conversationId } });
      check('the conversation itself still exists', Boolean(conversation));

      const report = await db.report.findFirst({ where: { reportedId: caller.id } });
      check('a report naming the deleted account survives', Boolean(report));
    } finally {
      await db.$disconnect();
    }
  }

  // ── Result ────────────────────────────────────────────────────────────────
  const removed = await removeCreatedAccounts();
  console.log(`\n  cleaned up ${removed} test account${removed === 1 ? '' : 's'}`);

  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  • ${f.label}${f.detail ? ` — ${JSON.stringify(f.detail)}` : ''}`);
    }
  }
  console.log(`${'═'.repeat(64)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(async (err) => {
  console.error('\nThe run itself failed:', err);
  // A failed run leaves accounts behind too, and those are the runs most
  // likely to be repeated — so the mess would compound exactly when somebody
  // is already debugging something else.
  try {
    const removed = await removeCreatedAccounts();
    console.error(`(cleaned up ${removed} test accounts anyway)`);
  } catch (cleanupError) {
    console.error('(cleanup also failed:', cleanupError.message, ')');
  }
  process.exit(1);
});
