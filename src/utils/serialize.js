'use strict';

const env = require('../config/env');

/**
 * The wire format.
 *
 * Keys are **snake_case** because that is what the Flutter models already
 * parse — `VybliUser.fromJson` reads `city_id`, `voice_rate_per_minute`,
 * `is_earner`. Enum values are sent as their **exact Dart enum names**
 * (`makeFriends`, `pendingOutgoing`, `voice`), because the client resolves
 * them with `values.byName(...)`. Both are load-bearing: rename a key here and
 * the field silently becomes null in the app rather than failing loudly.
 *
 * Serialising is also the last place privacy can be enforced, and therefore
 * the right one — a hidden city must be absent from the payload, not merely
 * unrendered by a client that could be swapped for curl.
 */

/** Rupee columns come back from Prisma as Decimal. */
const money = (value) => Number(value ?? 0);

const iso = (date) => (date ? new Date(date).toISOString() : null);

/** Under a week old earns the NEW badge on the discovery card. */
const NEW_ACCOUNT_DAYS = 7;
function isNewAccount(createdAt) {
  if (!createdAt) return false;
  const age = Date.now() - new Date(createdAt).getTime();
  return age < NEW_ACCOUNT_DAYS * 24 * 60 * 60 * 1000;
}

// ── Users ───────────────────────────────────────────────────────────────────

/**
 * Someone else's profile, as the discovery feed and profile screen expect it.
 *
 * `viewer` is only used to decide whether *this* viewer may see presence and
 * city. Pass null for an anonymous context.
 *
 * `favorited` says whether *this viewer* has starred this person — it is
 * never the other way around, and never tells `user` anything about who has
 * favorited them.
 */
/**
 * `viewerProfile` decides whose rate `voice_rate_per_minute` reports. A call
 * is priced at the *earner's* rate regardless of who initiates it — so a
 * female viewer looking at a male's card needs to see what *she* earns per
 * minute if she calls him, not his own (unused) field, which is never the
 * number either side is actually charged.
 */
function publicUser(user, { viewer = null, viewerProfile = null, favorited = false } = {}) {
  if (!user) return null;
  const profile = user.profile ?? user;
  const privacy = user.privacySettings ?? {};
  const rateOwner = viewerProfile?.isEarner ? viewerProfile : profile;

  // A viewer always sees their own detail in full, whatever they have hidden
  // from everyone else.
  const isSelf = viewer && viewer === user.id;
  const showPresence = isSelf || privacy.showOnlineStatus !== false;
  const showCity = isSelf || privacy.showCityOnProfile !== false;

  const languages = (user.languages ?? [])
    .map((l) => l.language?.name ?? l.name ?? null)
    .filter(Boolean);

  return {
    id: user.id,
    name: profile.name,
    age: profile.age,
    gender: profile.gender,

    // Hiding the city means sending nothing rather than sending a blank the
    // client has to know to distrust.
    city_id: showCity ? profile.cityId ?? '' : '',
    city_name: showCity ? profile.city?.name ?? '' : '',
    state_name: showCity ? profile.city?.state ?? '' : '',
    // Sent rather than assumed. The client used to fill in "India" itself when
    // rebuilding its home-city object, which is correct for every row seeded
    // so far and wrong the day a city outside it is added.
    country_name: showCity ? profile.city?.country ?? '' : '',

    languages,
    bio: profile.bio ?? '',

    // Presence hidden reads as offline — the honest projection of "you may
    // not know", and a state the client already renders.
    status: showPresence ? profile.presence : 'offline',
    last_seen: showPresence ? iso(profile.lastSeen) : null,

    avatar_url: profile.avatarUrl ?? null,
    is_verified: profile.isVerified ?? false,
    is_new: isNewAccount(user.createdAt),
    is_earner: profile.isEarner ?? false,
    is_favorite: favorited,

    voice_enabled: profile.voiceEnabled ?? true,
    video_enabled: profile.videoEnabled ?? true,

    rating: profile.rating ?? 0,
    total_calls: profile.totalCalls ?? 0,
    voice_rate_per_minute: money(rateOwner.voiceRatePerMinute),
    video_rate_per_minute: money(rateOwner.videoRatePerMinute),

    joined_label: joinedLabel(user.createdAt),
  };
}

function joinedLabel(createdAt) {
  if (!createdAt) return 'Joined recently';
  const months = Math.floor(
    (Date.now() - new Date(createdAt).getTime()) / (30 * 24 * 60 * 60 * 1000)
  );
  if (months < 1) return 'Joined this month';
  if (months === 1) return 'Joined 1 month ago';
  if (months < 12) return `Joined ${months} months ago`;
  const years = Math.floor(months / 12);
  return years === 1 ? 'Joined 1 year ago' : `Joined ${years} years ago`;
}

/**
 * The signed-in user's own profile.
 *
 * A superset of [publicUser] with the things only they may see: their phone
 * number, their chosen goal, and where they are in onboarding.
 */
function myProfile(user) {
  const base = publicUser(user, { viewer: user.id });
  const profile = user.profile ?? {};
  return {
    ...base,
    phone: user.phone,
    dial_code: user.dialCode,
    goal: profile.goal,
    onboarding_status: profile.onboardingStatus,
    account_status: user.status,
    created_at: iso(user.createdAt),
  };
}

/**
 * The user attached to a chat thread, call row or notification.
 *
 * Lighter than [publicUser] — it skips the bio-and-interests detail a list row
 * never shows — but deliberately carries **every field `VybliUser.fromJson`
 * requires**, so the client parses a thread's peer with the same model as a
 * profile rather than needing a second, laxer one. Trimming `city_id` to save
 * a dozen bytes would have cost a parallel parser.
 */
function userSummary(user) {
  if (!user) return null;
  const profile = user.profile ?? user;
  const privacy = user.privacySettings ?? {};
  const showPresence = privacy.showOnlineStatus !== false;
  const showCity = privacy.showCityOnProfile !== false;

  return {
    id: user.id,
    name: profile.name,
    age: profile.age,
    gender: profile.gender,
    city_id: showCity ? profile.cityId ?? '' : '',
    city_name: showCity ? profile.city?.name ?? '' : '',
    state_name: showCity ? profile.city?.state ?? '' : '',
    country_name: showCity ? profile.city?.country ?? '' : '',
    languages: (user.languages ?? [])
      .map((l) => l.language?.name ?? l.name ?? null)
      .filter(Boolean),
    bio: profile.bio ?? '',
    avatar_url: profile.avatarUrl ?? null,
    status: showPresence ? profile.presence : 'offline',
    last_seen: showPresence ? iso(profile.lastSeen) : null,
    is_verified: profile.isVerified ?? false,
    is_new: isNewAccount(user.createdAt),
    is_earner: profile.isEarner ?? false,
    voice_enabled: profile.voiceEnabled ?? true,
    video_enabled: profile.videoEnabled ?? true,
    rating: profile.rating ?? 0,
    total_calls: profile.totalCalls ?? 0,
    voice_rate_per_minute: money(profile.voiceRatePerMinute),
    video_rate_per_minute: money(profile.videoRatePerMinute),
  };
}

// ── Reference data ──────────────────────────────────────────────────────────

function city(row, activeUsers = 0) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    state: row.state,
    country: row.country,
    is_popular: row.isPopular,
    active_users: row._count?.profiles ?? activeUsers,
    // Present only when the request carried a coordinate. Null means "not
    // measured", which the client shows as nothing rather than as zero.
    distance_km: row.distanceKm ?? null,
  };
}

function language(row) {
  if (!row) return null;
  return {
    code: row.code,
    name: row.name,
    native_name: row.nativeName,
    is_popular: row.isPopular,
    aliases: row.aliases ?? [],
  };
}

// ── Messaging ───────────────────────────────────────────────────────────────

/**
 * One message. `author` is relative to whoever is asking — the client renders
 * "me" on the right and "them" on the left, and has no user id to compare
 * against in the bubble.
 */
function message(row, viewerId) {
  if (!row) return null;
  return {
    id: row.id,
    text: row.text ?? '',
    author: row.senderId === viewerId ? 'me' : 'them',
    sent_at: iso(row.createdAt),
    status: row.status,
    attachment: row.attachmentKind
      ? {
          kind: row.attachmentKind,
          title: row.attachmentTitle ?? '',
          subtitle: row.attachmentSubtitle ?? null,
          image_url: row.attachmentUrl ?? null,
          duration_label: row.attachmentDuration ?? null,
        }
      : null,
  };
}

/**
 * A conversation in the shape `ChatThread` expects.
 *
 * The app models a pending friend request and an open conversation as the same
 * object at different `status` values, so this collapses both into one thread:
 * `pendingIncoming` / `pendingOutgoing` / `accepted`.
 */
function chatThread(conversation, viewerId, { request = null, messages = [] } = {}) {
  const isA = conversation?.userAId === viewerId;
  const peer = isA ? conversation?.userB : conversation?.userA;

  let status = 'accepted';
  if (request && request.status === 'pending') {
    status = request.requesterId === viewerId ? 'pendingOutgoing' : 'pendingIncoming';
  }

  return {
    id: conversation.id,
    user: userSummary(peer),
    status,
    unread_count: isA ? conversation.unreadForA : conversation.unreadForB,
    is_muted: isA ? conversation.mutedByA : conversation.mutedByB,
    is_typing: false, // Live-only; the socket layer owns it.
    last_message_at: iso(conversation.lastMessageAt),
    messages: messages.map((m) => message(m, viewerId)),
  };
}

/**
 * A thread that exists only as a pending request — there is no conversation
 * row yet, because one is created on accept.
 */
function requestThread(request, viewerId) {
  const outgoing = request.requesterId === viewerId;
  const peer = outgoing ? request.addressee : request.requester;
  return {
    id: `req_${request.id}`,
    request_id: request.id,
    user: userSummary(peer),
    status: outgoing ? 'pendingOutgoing' : 'pendingIncoming',
    unread_count: 0,
    is_muted: false,
    is_typing: false,
    last_message_at: iso(request.createdAt),
    messages: request.message
      ? [
          {
            id: `req_msg_${request.id}`,
            text: request.message,
            author: outgoing ? 'me' : 'them',
            sent_at: iso(request.createdAt),
            status: 'sent',
            attachment: null,
          },
        ]
      : [],
  };
}

// ── Calls ───────────────────────────────────────────────────────────────────

/** A row in the Recent tab, from the perspective of `viewerId`. */
function callRecord(row, viewerId) {
  if (!row) return null;
  const outgoing = row.callerId === viewerId;
  const peer = outgoing ? row.callee : row.caller;
  const peerProfile = peer?.profile ?? {};
  const viewerIsEarner = Boolean(
    (viewerId === row.callerId ? row.caller : row.callee)?.profile?.isEarner
  );

  // "Missed" is a property of the row for the person who did not answer; for
  // the caller the same row is simply an outgoing call that never connected.
  const missed = row.status === 'missed';
  const direction = missed && !outgoing ? 'missed' : outgoing ? 'outgoing' : 'incoming';

  return {
    id: row.id,
    user_id: peer?.id ?? '',
    user_name: peerProfile.name ?? 'Unknown',
    city_name: peerProfile.city?.name ?? '',
    avatar_url: peerProfile.avatarUrl ?? null,
    type: row.type,
    direction,
    status: row.status,
    timestamp: iso(row.createdAt),
    duration_seconds: row.durationSeconds ?? 0,
    // Who pays and who earns is a role (isEarner), not a position (caller vs
    // callee) — an earner calling out still earns, and the other side still
    // pays. Showing an earner "you spent ₹40" would be nonsense.
    amount_spent: !viewerIsEarner ? money(row.amountSpent) : 0,
    earned_rupees: viewerIsEarner ? money(row.earning?.amount) : 0,
    rating: row.rating ?? null,
    end_reason: row.endReason ?? null,
  };
}

/** The live call handed to the call screen when it opens. */
function activeCall(row, viewerId) {
  if (!row) return null;
  const outgoing = row.callerId === viewerId;
  const peer = outgoing ? row.callee : row.caller;
  return {
    id: row.id,
    peer: userSummary(peer),
    type: row.type,
    status: row.status,
    is_outgoing: outgoing,
    is_random: row.isRandom,
    rate_per_minute: money(row.ratePerMinute),
    started_at: iso(row.startedAt),
    connected_at: iso(row.connectedAt),
    ended_at: iso(row.endedAt),
    duration_seconds: row.durationSeconds ?? 0,
    amount_spent: money(row.amountSpent),
    end_reason: row.endReason ?? null,
  };
}

// ── Money ───────────────────────────────────────────────────────────────────

function walletSummary(wallet, { isEarner = false } = {}) {
  return {
    balance: money(wallet?.balance),
    // A friends account never earns, so it is sent zeros rather than being
    // left to interpret nulls.
    total_earnings: isEarner ? money(wallet?.totalEarnings) : 0,
    available_balance: isEarner ? money(wallet?.availableBalance) : 0,
    pending_balance: isEarner ? money(wallet?.pendingBalance) : 0,
    is_earner: isEarner,
    min_withdrawal: env.economy.minWithdrawalInr,
    vip_expires_at: iso(wallet?.vipExpiresAt),
  };
}

function upiAccount(account) {
  return {
    linked: account.linked,
    upi_id: account.upiId ?? null,
  };
}

function walletTransaction(row) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    subtitle: row.subtitle ?? '',
    timestamp: iso(row.createdAt),
    status: row.status,
    // How much this row moved, in rupees — positive for a credit, negative
    // for a debit. Null only for a row that predates the ledger carrying an
    // amount at all.
    amount:
      row.rupeeDelta === null || row.rupeeDelta === undefined ? null : money(row.rupeeDelta),
  };
}

function rechargePackage(row) {
  return {
    id: row.id,
    price_inr: money(row.priceInr),
    bonus_inr: money(row.bonusInr),
    is_popular: row.isPopular,
    is_best_value: row.isBestValue,
    tagline: row.tagline ?? null,
  };
}

function vipPlan(row) {
  return {
    id: row.id,
    days: row.days,
    price_inr: money(row.priceInr),
    bonus_inr: money(row.bonusInr),
    is_best: row.isBest,
  };
}

function earning(row) {
  return {
    id: row.id,
    call_id: row.callId,
    amount: money(row.amount),
    minutes: row.minutes,
    rate_per_minute: money(row.ratePerMinute),
    status: row.status,
    clears_at: iso(row.clearsAt),
    created_at: iso(row.createdAt),
  };
}

// ── Everything else ─────────────────────────────────────────────────────────

function notification(row) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body ?? '',
    data: row.data ?? null,
    is_read: Boolean(row.readAt),
    created_at: iso(row.createdAt),
  };
}

function friendRequest(row, viewerId) {
  const outgoing = row.requesterId === viewerId;
  return {
    id: row.id,
    direction: outgoing ? 'outgoing' : 'incoming',
    status: row.status,
    message: row.message ?? null,
    user: userSummary(outgoing ? row.addressee : row.requester),
    created_at: iso(row.createdAt),
    responded_at: iso(row.respondedAt),
  };
}

function privacySettings(row) {
  return {
    profile_visible_to_everyone: row.profileVisibleToEveryone,
    show_online_status: row.showOnlineStatus,
    show_city_on_profile: row.showCityOnProfile,
    allow_voice_calls: row.allowVoiceCalls,
    allow_video_calls: row.allowVideoCalls,
    allow_messages: row.allowMessages,
  };
}

function notificationSettings(row) {
  return {
    incoming_calls: row.incomingCalls,
    missed_calls: row.missedCalls,
    messages: row.messages,
    new_matches: row.newMatches,
    earnings: row.earnings,
    promotions: row.promotions,
  };
}

function discoverySettings(row) {
  return {
    min_age: row.minAge,
    max_age: row.maxAge,
    genders: row.genders,
    languages: row.languages,
    voice_calls: row.voiceCalls,
    video_calls: row.videoCalls,
  };
}

function verification(row) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    language_code: row.languageCode ?? null,
    duration_seconds: row.durationSeconds,
    rejection_reason: row.rejectionReason ?? null,
    reviewed_at: iso(row.reviewedAt),
    created_at: iso(row.createdAt),
  };
}

module.exports = {
  publicUser,
  myProfile,
  userSummary,
  city,
  language,
  message,
  chatThread,
  requestThread,
  callRecord,
  activeCall,
  walletSummary,
  walletTransaction,
  upiAccount,
  rechargePackage,
  vipPlan,
  earning,
  notification,
  friendRequest,
  privacySettings,
  notificationSettings,
  discoverySettings,
  verification,
  iso,
  money,
};
