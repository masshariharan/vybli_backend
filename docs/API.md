# Vybli API

REST at `/api/v1`, Socket.IO on the same port. Built for the Vybli Flutter app
— the response shapes match its existing models, so `VybliUser.fromJson`,
`CallRecord.fromJson` and the rest parse the wire format unchanged.

---

## Conventions

**Keys are `snake_case`.** That is what the Flutter models parse
(`city_id`, `voice_coins_per_minute`, `is_earner`). Enum *values* are the exact
Dart enum names (`makeFriends`, `pendingOutgoing`, `voice`), because the client
resolves them with `values.byName(...)`.

Every response is one of two shapes:

```jsonc
{ "success": true,  "message": "Request successful", "data": { } }
{ "success": false, "message": "Friend request already exists",
  "error": "FRIEND_REQUEST_EXISTS", "details": { } }
```

Lists add pagination inside `data`:

```jsonc
{ "success": true, "data": {
    "items": [ ],
    "pagination": { "page": 1, "limit": 20, "total": 57,
                    "total_pages": 3, "has_next": true, "has_previous": false }
} }
```

Authenticate with `Authorization: Bearer <access_token>`. The user is taken
from the token — **no endpoint accepts a user id meaning "who I am"**.

### Status codes

| Code | Meaning |
| --- | --- |
| 200 / 201 | Fine |
| 400 | Malformed or contradictory request |
| 401 | Missing, invalid or expired token |
| 402 | Payment required — out of coins, or a declined purchase |
| 403 | Authenticated but not allowed (blocked, not friends, privacy) |
| 404 | Not found, or hidden from you and treated as not found |
| 409 | Conflicts with current state (already friends, callee busy) |
| 422 | Validation failed — `details` maps field → message |
| 429 | Rate limited |
| 500 | Our fault |

### Error codes

Branch on `error`, never on `message` — messages get reworded.

`UNAUTHORIZED` · `INVALID_TOKEN` · `ACCOUNT_SUSPENDED` · `ONBOARDING_INCOMPLETE`
· `VALIDATION_ERROR` · `RATE_LIMITED`
`OTP_INVALID` · `OTP_EXPIRED` · `OTP_TOO_MANY_ATTEMPTS` · `OTP_COOLDOWN`
`REQUEST_TO_SELF` · `FRIEND_REQUEST_EXISTS` · `ALREADY_FRIENDS` ·
`CHAT_ROLE_MISMATCH` · `FRIEND_REQUEST_NOT_FOUND` · `REQUEST_NOT_PENDING`
`BLOCKED` · `NOT_FRIENDS` · `MESSAGING_DISABLED_SELF` · `MESSAGING_DISABLED_PEER`
`CALL_TYPE_DISABLED` · `CALLEE_OFFLINE` · `CALLEE_BUSY` · `CALLER_BUSY` ·
`NO_MATCH_AVAILABLE` · `CALL_NOT_RINGING` · `CALL_NOT_ENDED`
`INSUFFICIENT_COINS` · `PAYMENT_FAILED` · `WITHDRAWAL_BELOW_MINIMUM` ·
`NOT_EARNER_ACCOUNT`

`ONBOARDING_INCOMPLETE` carries `details.next_status`, and
`INSUFFICIENT_COINS` carries `details.required` and `details.balance`, so the
client can route or offer a top-up without a second call.

---

## Two rules that shape everything

Both come from the app, and the API enforces them rather than trusting the UI:

1. **Only Earn Money profiles are discoverable, and only they can receive a
   friend request.** Everyone else browses and sends. A regular account has no
   received-requests list because it can never have one.
2. **Messaging is unlocked by an accepted friend request and nothing else.**
   Calling a stranger is the product; messaging one is what the gate prevents.

---

## Auth

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/auth/otp/request` | — | Send a code to a number |
| POST | `/auth/otp/verify` | — | Verify and sign in (creates the account if new) |
| POST | `/auth/refresh` | — | Trade a refresh token for a new pair |
| GET | `/auth/me` | ✓ | Is my token still good |
| POST | `/auth/logout` | ✓ | End this session, or all of them |
| DELETE | `/auth/account` | ✓ | Delete the account — body `{ reason? }` |

**Deleting takes no confirmation code.** The client confirms in its own UI and a
valid access token is the authority — `POST /auth/delete/request-code` is gone.
That is a product choice, not an oversight: the SMS round trip cost a message
per attempt and a step per user, and the account it guarded sits behind a phone
lock either way.

The row itself is kept and anonymised rather than dropped: call history, ledger
entries and the other side of every conversation reference it, so a hard delete
would corrupt other people's data. The profile is wiped, friendships and pending
requests are removed, every session is revoked, privacy is locked shut, and the
phone number is tombstoned to `deleted_<id>_<phone>` — which frees the number,
so signing up again on it produces a genuinely new account starting at
`PHONE_VERIFIED`.

Sign-up and sign-in are the same call. Whether a row exists is the server's
business, not a question to ask someone who wants to get in.

**POST `/auth/otp/request`**
```jsonc
{ "dial_code": "+91", "phone": "9876543210" }
→ { "expires_at": "…", "is_existing_user": false, "dev_code": "418302" }
```
`dev_code` is returned only when `OTP_DEV_MODE=true`. That is a plain flag you
control, respected wherever this runs — there is no environment that overrides
it and none that refuses to start because of it. Turn it off before the OTP
sign-in path is reachable by anyone you do not trust; the shipped app signs in
through Firebase and never touches this endpoint.

**POST `/auth/otp/verify`**
```jsonc
{ "dial_code": "+91", "phone": "9876543210", "code": "418302", "device": "Pixel 8" }
→ { "access_token": "…", "refresh_token": "…", "token_type": "Bearer",
    "is_new_user": true, "onboarding_status": "PHONE_VERIFIED", "user": { … } }
```

Refresh tokens **rotate**: refreshing revokes the old one, so a stolen token is
good only until its owner next refreshes.

---

## Onboarding

Resumable. Each step commits on its own; ask `/onboarding/status` and go where
it says. Status only moves forward, so editing an earlier answer does not drag
the user back a screen.

```
PHONE_VERIFIED → GENDER_COMPLETED → AGE_COMPLETED → LANGUAGE_COMPLETED
→ LOCATION_COMPLETED → MODE_SELECTED → ONBOARDING_COMPLETED
```

Both roles complete the same way — there is no verification step in
onboarding. An earner's identity review starts automatically the moment
`ONBOARDING_COMPLETED` lands, and is decided afterwards, manually, from the
admin panel; see [Notifications, moderation, verification](#notifications-moderation-verification).

There is no separate "pick a mode" screen or endpoint. `goal`/`isEarner` are
derived from gender the moment `/onboarding/location` lands — female →
`earnMoney`, male → `makeFriends` — and `MODE_SELECTED` is set in the same
call. `POST /onboarding/mode` no longer exists.

| Method | Path | Body |
| --- | --- | --- |
| GET | `/onboarding/status` | — |
| POST | `/onboarding/gender` | `{ "gender": "female" }` |
| POST | `/onboarding/age` | `{ "age": 24 }` |
| POST | `/onboarding/languages` | `{ "language_codes": ["en","ta"] }` |
| POST | `/onboarding/location` | `{ "city_id": "chennai" }` (also sets `goal`/`isEarner`) |
| POST | `/onboarding/profile` | `{ "name": "Meera", "bio": "…" }` |
| POST | `/onboarding/complete` | — |

Every step replies `{ onboarding_status, next_step, user }`.

`/onboarding/complete` re-checks everything rather than trusting the status
column, and answers `400` with `details.missing` naming the first gap.

---

## Me

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/me` | My profile (includes phone, goal, onboarding status) |
| PATCH | `/me` | Update name, age, bio, city, languages. No `gender` — fixed once set at onboarding, since it decides caller/earner status. No `avatar_url` or `avatar_id` either — see `/me/avatar` below. |
| PUT | `/me/avatar` | `{ "avatar_id": "male_01" }`. The only way an avatar is set — checked against the predefined catalog (`GET /avatars`), never a file upload. |
| PUT | `/me/presence` | `{ "status": "online" \| "offline" \| "busy" }`. An override; the normal source of presence is the socket itself — connected means online, and the last device disconnecting means offline. Idempotent: setting the status already held writes nothing and notifies nobody. |
| GET / PUT | `/me/languages` | Read / replace my language **codes**. Codes both ways — the catalogue that turns `ta` into "Tamil" ships inside the app, not here. |
| GET / PATCH | `/me/settings/privacy` | Privacy |
| GET / PATCH | `/me/settings/notifications` | Notifications |
| GET / PATCH | `/me/settings/discovery` | Discovery filters |
| POST | `/me/settings/discovery/reset` | Back to defaults |

### Privacy, and what each switch actually does

Every one has a server-side consequence — none is decoration.

| Field | Effect |
| --- | --- |
| `profile_visible_to_everyone` | Off removes you from discovery, and from direct lookup by strangers. Friends can still open your profile. |
| `show_online_status` | Off makes you read as `offline` to others and suppresses `last_seen`. You still see your own real status. |
| `show_city_on_profile` | Off omits city from your payload entirely — not blanked client-side. |
| `allow_voice_calls` / `allow_video_calls` | Off refuses that call type with `CALL_TYPE_DISABLED` and updates the profile others see. |
| `allow_messages` | Full opt-out: no conversations, no friend requests, nothing sent or received. Calls unaffected. |

With `allow_messages` off, `GET /conversations` returns an **empty list with
`messaging_disabled: true`**, not a 403 — the client has a state for it, and an
error would turn a setting into a failure.

---

## Reference data

Public — the onboarding screens need them before anyone is signed in.

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/cities/stats` | `{ "counts": { "chennai": 4, … } }` |
| GET | `/location/ip-estimate` | `{ "lat": 13.08, "lng": 80.27 }`, or nulls |
| GET | `/avatars` | `gender` (`male` \| `female`) |

**Neither catalogue is served.** Cities and languages are both static — 224
city slugs with coordinates, 67 language codes — so both are compiled into the
Flutter app (`lib/data/catalogue/`) and never fetched. The API deals only in
ids: it stores the ones it is given, matches and counts on them, and has no
opinion about which exist. An id from a newer app build is stored, not refused.

That is why there is no `/cities` and no `/cities/nearest`. Coordinate-to-city
resolution happens **on the device**: the phone holds the fix, names its own
state with the platform geocoder, and matches against the bundled coordinates.
Nothing about a user's location leaves the handset.

`/cities/stats` is the one thing about a city the app cannot work out — online,
visible earners per city, counted against the same predicate discovery uses.
Cities with nobody in them are omitted; an absent id means zero.

`/location/ip-estimate` answers the one thing a phone cannot work out about
itself: roughly where its public address is, for handsets that produce no fix
at all. It returns a **coordinate, never a city** — which city that is stays on
the client. Nulls when no provider is configured or the lookup fails, which the
client treats as "ask the user".

---

## Discovery

**GET `/users/discover`**

`scope` (`myCity` | `selectedCity` | `allCities`), `city_id` (required with
`selectedCity`), `q`, `min_age`, `max_age`, `genders`, `languages`
(comma-separated **codes**, e.g. `ta,hi`), `online_only`, `page`, `limit`.

Filters default to the saved Discovery Settings; query params override for
one-off filtering. Sorted online → busy → offline, then by rating.

When both call types are switched off the reply is an empty list with
`empty_reason: "NO_CALL_TYPES_ENABLED"` — an empty feed has more than one
cause and "widen your filters" is bad advice for this one.

**POST `/users/random-match`**
```jsonc
{ "scope": "myCity", "type": "voice", "exclude_ids": ["…"] }
→ { "user": { … }, "type": "voice", "rate_per_minute": 12 }
```
Returns the match only — placing the call is a separate step, so Skip costs
nothing. `exclude_ids` stops the same face being re-offered.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/users/:id` | Public profile + `connection_status` |
| GET | `/users/:id/connection` | Just the relationship |
| GET | `/users/:id/conversation` | The thread with them, if any |

`connection_status` is `none` \| `requestSent` \| `requestReceived` \| `friends`
— exactly the four states the profile's primary button renders.

---

## Friends

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/friends` | My friends |
| GET | `/friends/requests` | `direction=incoming\|outgoing\|all`, `status` |
| POST | `/friends/requests` | `{ "user_id", "message" }` |
| POST | `/friends/requests/:id/accept` | Accept |
| POST | `/friends/requests/:id/reject` | Decline (they are not told) |
| DELETE | `/friends/requests/:id` | Withdraw one you sent |
| DELETE | `/friends/:id` | Unfriend |

Sending to someone whose request is already in your inbox **accepts it**
instead, and the reply says `auto_accepted: true` — telling the user "already
exists" when the answer is on their own screen would be obtuse.

Accepting creates the friendship *and* the conversation in one transaction, and
carries the request's opening message in as the first message.

Unfriending deletes the conversation. A thread that can no longer be replied to
is the dead end the gate exists to prevent.

---

## Conversations

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/conversations` | `filter=accepted\|requests\|all` — the two Chats tabs |
| GET | `/conversations/unread` | Badge: unread + pending requests |
| GET | `/conversations/:id` | Open a thread — **also marks it read** |
| POST | `/conversations/:id/messages` | Send |
| POST | `/conversations/:id/read` | Mark read |
| PATCH | `/conversations/:id/mute` | `{ "muted": true }` |
| DELETE | `/conversations/messages/:id` | Delete your own (soft) |

`filter=requests` returns pending friend requests shaped as threads
(`status: "pendingOutgoing"` / `"pendingIncoming"`) — the app models them as a
conversation at an earlier status, not a different object.

Thread history is **cursor-paged** with `?before=<message_id>`. Messages arrive
while you scroll and an offset would skip or repeat rows.

`author` is `"me"` or `"them"` relative to the reader, so a bubble needs no id
comparison.

Every send re-checks friendship, blocking and both privacy switches — not once
when the thread opens. Either side can close the door mid-conversation.

---

## Calls

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/calls/active` | Rejoin a call after an app restart |
| GET | `/calls/history` | `direction=all\|incoming\|outgoing\|missed` |
| DELETE | `/calls/history` | Clear the log |
| POST | `/calls` | `{ "user_id", "type", "is_random" }` |
| POST | `/calls/:id/accept` | Answer |
| POST | `/calls/:id/reject` | Decline |
| POST | `/calls/:id/cancel` | Hang up before it is answered |
| POST | `/calls/:id/end` | Hang up |
| POST | `/calls/:id/rate` | `{ "rating": 1–5 }` — caller only |
| POST | `/calls/:id/token` | A fresh LiveKit token for a call in progress |
| DELETE | `/calls/:id` | Remove one row from the log |
| GET | `/livekit/status` | Whether this deployment can carry media |
| POST | `/livekit/webhook` | LiveKit's own callback — signed, not authenticated |

### Media

Audio and video ride on **LiveKit**. This server never touches the media path;
it decides who may call whom, runs the billing clock, and hands each
participant a token for one room.

Every response carrying a *live* call includes that viewer's credentials:

```json
{
  "call": {
    "id": "cmsw…",
    "status": "connected",
    "livekit": {
      "url": "wss://your-project.livekit.cloud",
      "room": "call_cmsw…",
      "token": "eyJhbGciOi…",
      "can_publish_video": false
    }
  }
}
```

* **One room per call**, named `call_<id>`, and the participant identity is the
  user id — so a room maps back to a call and a participant to an account with
  no lookup table.
* **Tokens are per-viewer.** The caller's token would let the callee publish as
  the caller, so they are never shared. `livekit` is `null` on a finished call.
* **The grant is narrow**: `roomJoin` for that room only, and
  `canPublishSources` is microphone-only on a voice call — a video grant there
  would be a paid feature given away.
* **Short-lived** (`LIVEKIT_TOKEN_TTL`, 15 minutes by default). A long call
  that needs to reconnect asks `POST /calls/:id/token` rather than holding a
  long-lived credential.
* **The room is destroyed the moment the call ends** — every path, including
  the out-of-coins cut-off. Leaving it open would be free minutes.

The webhook is what ends a call when a phone dies mid-conversation: no hang-up
arrives, the socket takes a while to notice, and the billing ticker would keep
charging. LiveKit knows within seconds and says so. It is verified by
signature, since it arrives with no user session. Point your LiveKit project's
webhook at `https://your-api/api/v1/livekit/webhook`.

### Billing

**Charged at the start of each minute, minute one on connect.** A 10-second
call costs one minute; a 61-second call costs two — which is what "12 coins per
minute" means to someone reading it on a card.

* The balance must cover the first minute **before it rings**.
* The rate is snapshotted onto the call, so history keeps saying what it cost
  even after the profile's price changes.
* Billing runs on the **server's** clock. A killed client changes nothing.
* Out of coins mid-call → the call ends with
  `end_reason: "insufficientCoins"`, and `call:low_balance` warns one minute
  earlier over the socket.
* Unanswered calls become `missed` after 45s.

`POST /calls/:id/end` replies with a `summary` — `duration_seconds`,
`coins_spent`, `end_reason`, `ran_out_of_coins` — which is exactly what the
Call Ended screen renders.

History rows are per-viewer: the caller sees `coins_spent`, the earner sees
`earned_rupees`, and the same row reads `outgoing` for one and `incoming` for
the other.

---

## Wallet

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/wallet` | ✓ | Coins, and earnings for earners |
| GET | `/wallet/packages` | ✓ | Coin packages (priced server-side) |
| GET | `/wallet/transactions` | ✓ | Ledger, `kind` filter |
| POST | `/wallet/purchase` | ✓ | `{ "package_id", "method" }` |
| GET | `/wallet/earnings` | earner | Earning rows |
| POST | `/wallet/withdraw` | earner | `{ "amount" }` (optional — defaults to all) |

**The client never supplies an amount.** It names a package; the server prices
it. Every balance change writes a ledger row in the same transaction, and
debits are conditional updates (`coins: { gte: n }`), so two concurrent charges
cannot both pass a check.

A friends account is shown `total_earnings: 0` and `is_earner: false` rather
than nulls. Its ledger needs no filtering: the endpoint returns the rows
belonging to that account, and an account that never earned has no earning rows.

Earnings land in `pending` and mature after 48h, moved forward on read so no
scheduler is required. `Earning.callId` is unique — the constraint *is* the
duplicate-payment guard.

`POST /wallet/purchase` depends on `PAYMENT_PROVIDER`. With `none` — no payment
service provider wired in — with `PAYMENT_PROVIDER=none` it credits the wallet
directly, labelling the ledger row "no payment taken". That is the behaviour
wherever it runs: the flag is respected as written and nothing overrides it by
environment. Until a real provider is set, this endpoint is an authenticated
way to get coins for free, so set one before anyone you do not trust can reach
it. With a provider configured but its verification failing, the answer is
`503 PAYMENTS_UNAVAILABLE`.

---

## Notifications, moderation, verification

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/notifications` | `unread_only` |
| GET | `/notifications/unread-count` | Badge |
| POST | `/notifications/:id/read` | Mark one |
| POST | `/notifications/read-all` | Mark all |
| GET | `/moderation/blocked` | Blocked list |
| POST | `/moderation/block` | `{ "user_id" }` |
| DELETE | `/moderation/block/:id` | Unblock |
| POST | `/moderation/report` | `{ "user_id", "reason", "details", "also_block" }` |
| GET | `/verification/status` | `{ "is_verified", "status", "rejection_reason" }` |

**Blocking is a full severance**, not a discovery filter: the friendship and
conversation are deleted, pending requests are cancelled, a live call is
ended, messages and calls are refused, and `connection_status` collapses to
`none`. Unblocking restores nothing — send a fresh request.

Notification settings are honoured centrally, so a feature says "this
happened" and one place decides whether the user hears about it.

**Identity verification is decided by a person**, in the admin panel, and
there is nothing for a client to submit — `GET /verification/status` is
read-only. `status` is one of `not_required` (a Make Friends account, or an
earner still onboarding), `pending`, `verified`, or `rejected`.

An earner is queued `pending` automatically the moment onboarding finishes —
see `onboardingService.complete` — and `POST
/admin/verifications/:id/decide` (`{ "decision": "verified" | "rejected",
"reason" }`, `:id` the user id) is the only thing that ever moves it on from
there, or sets `isVerified`. The queue itself is `GET /admin/verifications`.

Onboarding completes without waiting on a decision — an account would
otherwise be locked out of every route past onboarding for as long as the
queue is. Being discoverable stays gated on `isVerified`, which is separate
and starts `false`.

---

## Admin

Mounted at `/api/v1/admin`. A separate surface with its own authentication —
the two token types are signed with different secrets, so a user token can
never be replayed as an administrator's and vice versa.

There is **one** administrator, configured through the environment. No
registration endpoint exists, and there is no admin table in Postgres.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/admin/auth/login` | `{ username, password }` — the only unauthenticated admin route |
| POST | `/admin/auth/logout` | Audited; the token is stateless and discarding it is what ends it |
| GET | `/admin/auth/session` | Who is signed in, and until when |
| GET | `/admin/dashboard` | ~40 live counts |
| GET | `/admin/dashboard/analytics` | `?metrics=a,b&days=30` or `&from=&to=` |
| GET | `/admin/users` | `?search=&filter=&sort=&direction=&from=&to=` |
| GET | `/admin/users/:id` | Profile plus the full statistics block |
| GET | `/admin/users/:id/{activity,friends,requests,messages,calls,verification,wallet,transactions,earnings,reports,blocks,notifications,history}` | The thirteen tabs |
| POST | `/admin/users/:id/status` | `{ status, reason }` — a reason is required to suspend |
| POST | `/admin/users/:id/wallet/adjust` | `{ coins, rupees, reason }` — reason required |
| GET | `/admin/conversations` | Every conversation, or one user's |
| GET | `/admin/conversations/:id` | Full chat history, cursor-paginated. **Audited** |
| GET | `/admin/messages` | `?search=` searches content. **Audited**. No query returns stats only |
| GET | `/admin/activity` | The platform-wide timeline |
| GET | `/admin/calls`, `/admin/calls/live`, `/admin/livekit/rooms` | History, in-progress, and the media server's own view |
| GET | `/admin/friend-requests` | |
| GET | `/admin/verifications` | The identity-review queue, oldest request first |
| POST | `/admin/verifications/:id/decide` | `:id` is the user id. `{ decision, reason }` — reason required to reject |
| GET | `/admin/reports`, `/admin/blocks` | |
| POST | `/admin/reports/:id/resolve` | `{ status, resolution, notes }` |
| GET | `/admin/wallets`, `/admin/earnings`, `/admin/transactions` | |
| GET | `/admin/notifications` | |
| GET | `/admin/audit-logs` | Read-only. There is no write route |

### Authentication

`Authorization: Bearer <admin token>`, issued by the login route and valid for
`ADMIN_SESSION_EXPIRY`. Login is rate-limited per address and locks out after
`ADMIN_MAX_FAILED_LOGINS` wrong passwords; username and password are compared
in constant time and produce the same message, so a response never reveals
which half was wrong.

### The audit log

Every administrator action **and every read of private data** is recorded with
the action, the target, the account concerned, a description, the IP and the
user agent. That includes `conversation.viewed`, `messages.searched` and
`verification.verified` / `verification.rejected` — reading somebody's private
conversation is the most invasive thing this API can do, and it leaves a
trace.

Append-only by construction: no route updates or deletes an entry.

### Realtime

A separate Socket.IO namespace, `/admin`, authenticated with the same admin
token. It is **read-only** — every action goes through REST, where it is
validated and audited, and a socket that could suspend an account would be a
second unaudited path to the same power.

| Event | When |
| --- | --- |
| `admin:user_registered` / `admin:user_signed_in` | A new account, or a sign-in |
| `admin:presence_changed` | Anyone came online or went offline |
| `admin:friend_request` | A request was sent |
| `admin:message_sent` | A message was delivered |
| `admin:call_started` / `admin:call_ended` | Call lifecycle, with the participants |
| `admin:verification_pending` | An earner finished onboarding and was queued for review |
| `admin:report_filed` | Somebody was reported |

---

## Socket.IO

Same port. Authenticate in the handshake:

```js
io('http://localhost:4000', { auth: { token: accessToken } });
```

An unauthenticated socket is never created — the token is checked before the
connection is accepted, and a bad one fails with `UNAUTHORIZED`.

Every user joins a room keyed on their id, so "tell this person" is one emit
regardless of how many devices they have open.

### On connect

```jsonc
"connected" → { "user_id": "…", "unread": { … }, "active_call": { … } | null }
```
`active_call` is how a client that restarted mid-call rejoins instead of
losing it.

### Client → server

| Event | Payload | Ack |
| --- | --- | --- |
| `presence:set` | `{ status }` | ✓ |
| `presence:query` | `{ user_ids }` | ✓ — friends only |
| `message:send` | `{ conversation_id, text, attachment, client_id }` | ✓ |
| `message:read` | `{ conversation_id }` | ✓ |
| `typing` | `{ conversation_id, is_typing }` | — |
| `call:start` | `{ user_id, type, is_random }` | ✓ |
| `call:accept` / `call:reject` / `call:cancel` | `{ call_id }` | ✓ |
| `call:end` | `{ call_id, reason }` | ✓ |

There is deliberately no `call:signal` or `call:media`. Both existed when the
client relayed SDP and mirrored mute state by hand; LiveKit carries all of it
now, and two paths for the same state is how a mute icon comes to disagree
with the audio.

Acks are `{ success, data }` or `{ success, error, message }`.

Socket handlers call the **same services** as the REST routes. A rule enforced
in a controller and forgotten in a socket handler is a rule that does not
exist, and a client can always pick the weaker path.

### Server → client

| Event | When |
| --- | --- |
| `presence:changed` | A friend came online or went offline. Only friends, and only on an actual change — re-asserting a status nobody's view of the world depends on sends nothing |
| `message:new` | A message arrived |
| `message:sent` | Your own send, for your other devices |
| `message:read` | They read your message |
| `message:deleted` | A message was withdrawn |
| `typing` | They are typing |
| `friend:request` | Someone asked to connect |
| `friend:accepted` | They accepted — carries `conversation_id` |
| `friend:cancelled` / `friend:removed` | Withdrawn / unfriended |
| `call:incoming` | Your phone is ringing |
| `call:ringing` | Your outgoing call is ringing |
| `call:accepted` / `call:connected` | Answered |
| `call:ended` | Over — carries duration and cost |
| `call:low_balance` | One minute of credit left |
| `call:charged` | A minute was billed — carries the running `coins_spent` |
| `notification:new` / `notification:count` | New notification / badge |
| `wallet:updated` | Balance changed |
| `user:blocked_by` | Someone blocked you |

Presence and call events are checked against the database, not taken on trust:
a stranger cannot fake a typing indicator or reach into someone else's call.

---

## Rate limits

| Scope | Limit |
| --- | --- |
| Global | 120 / min per IP |
| OTP request | 5 / 15 min **per phone number** |
| OTP verify | 15 / 15 min per number |
| Writes (messages, requests, reports) | 60 / min per user |
| Payments | 10 / min per user |

OTP limits key on the **number**, not the IP — one attacker hitting a hundred
different numbers is the case an IP limit misses.

---

## Running it

```bash
# .env already exists, real values and all — every field documented inline.
npm install
npx prisma migrate deploy
npm run seed              # 5 coin packages, VIP plans (no catalogues — see above)
npm run dev

# Deployed, the first two are automatic: `docker-entrypoint.sh` migrates and
# seeds on every boot, so a fresh environment is never born with an empty
# price list. Only a local `npm run dev` needs them typed out.
```

Tests need the server running:

```bash
npm run test:e2e          # ~200 checks over the whole journey
npm run test:sockets      # ~35 checks over the real-time layer
```

---

## Known limits

Honest about what is stubbed, and where the seam is:

| Area | State | Seam |
| --- | --- | --- |
| SMS | Codes logged, returned in dev | `deliver()` in `otp.service.js` |
| Payments | `PAYMENT_PROVIDER=none` credits the wallet directly with **no payment taken**, wherever it runs — set a real provider before strangers can reach it | `purchase()` in `wallet.service.js` |
| Payouts | Recorded `pending`, never settled | `withdraw()` in `wallet.service.js` |
| Attachments | URLs stored, nothing uploaded | Attachment fields on `Message` |
| Push | In-app only; nothing wakes a closed app | Needs FCM / APNs |

**Scaling:** per-minute billing timers are in-process. A multi-instance
deployment needs them behind a shared store (Redis, or a job queue keyed on
call id) and Socket.IO needs its Redis adapter. Everything else is stateless.
