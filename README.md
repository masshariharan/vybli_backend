# Vybli Backend

Node.js · Express · PostgreSQL · Prisma · Socket.IO

The backend for the Vybli Flutter app. Built from the app's actual screens and
flows rather than from a generic template — the response shapes match its
existing models, so `VybliUser.fromJson`, `CallRecord.fromJson` and the rest parse
the wire format unchanged.

```bash
# .env already exists in this checkout, real values and all — every field is
# documented inline in the file itself. Point DATABASE_URL at your Postgres
# and you're set; see its own comments for anything else you want to turn on.
npm install
npx prisma migrate deploy
npm run seed              # the coin packages and VIP plans
npm run dev               # http://localhost:4000
```

`npm run seed` loads only what the server genuinely owns — the 5 coin
packages and the VIP plans. Neither catalogue is in it: cities and languages are
both static and ship inside the Flutter app, so the server only ever stores the
city id and language codes a profile was saved with.

**In a deployed environment you never run it by hand.** `docker-entrypoint.sh`
runs the migrations and then this seed on every boot, so the prices in the
running image are always the prices in the database. It is only listed here
because a local `npm run dev` does not go through that entrypoint.

### Accounts to test with

There is no seeder for these any more. `seed-demo.js` wrote 22 fixture profiles
marked `isDemo`, and every query that could expose one needed a predicate to
hide it — the discovery feed had one, the per-city member counts did not, and
for a while the city picker counted people the feed would then refuse to show.
A category of row that must be hidden everywhere is a rule every future query
has to remember, and eventually one does not.

So sign up the way a user does. `OTP_DEV_MODE=true` in `.env` prints the code to
the server log instead of sending an SMS, which makes creating an account on a
second device a few seconds' work. Two real accounts — one Earn Money, one Make
Friends, since the feed only ever pairs opposite roles — is everything the
product needs to be reachable end to end.

Full reference: [`docs/API.md`](docs/API.md).
Postman: [`docs/vybli.postman_collection.json`](docs/vybli.postman_collection.json)
— 75 requests ordered as a walkthrough, with scripts that capture tokens and
ids as you go.

---

## The two rules everything hangs off

Both come from the app. The API enforces them; it does not trust the UI to.

1. **Only Earn Money profiles are discoverable, and only they can receive a
   friend request.** Everyone else browses and sends. A regular account has no
   received-requests list because it can never have one.
2. **Messaging is unlocked by an accepted friend request and nothing else.**
   Calling a stranger is the product — it is what discovery is for and what
   coins pay for. Messaging one is what the gate prevents.

A third, less obvious: **coins and rupees never convert.** Callers spend coins
they bought; earners accrue rupees they withdraw. One wallet row holds both so
a call can debit one and credit the other atomically.

---

## Layout

```
src/
├── config/        env (validated at boot), prisma client
├── middleware/    auth, validation, errors, rate limits
├── validators/    zod schemas — the entire input surface
├── services/      all business rules live here
├── controllers/   HTTP → service → response shape
├── routes/        the whole API surface, in one readable file
├── sockets/       Socket.IO + the service→socket event bus
├── utils/         errors, tokens, serializers, response envelope
├── app.js         express wiring
└── server.js      boot, reconciliation, graceful shutdown
```

```
Route → Controller → Service → Prisma → PostgreSQL
```

Controllers hold no rules. If one starts branching on something other than the
shape of the request, that decision belongs in a service — otherwise it gets
implemented once for REST and forgotten for the socket handlers, and a client
can pick whichever path is weaker.

`services/relationship.service.js` is the one worth reading first. "May A do
this to B?" is asked in exactly one place there, because answering it per
feature is how a check ends up enforced on three paths and missed on the
fourth.

---

## Wiring the Flutter app to it

Screen by screen. Every response is `{ success, message, data }`; lists add
`data.pagination`.

| Screen | Calls | Notes |
| --- | --- | --- |
| Splash | `GET /auth/me` | Valid token → route by `onboarding_status` |
| Login | `POST /auth/otp/request` | `dev_code` comes back in dev |
| OTP | `POST /auth/otp/verify` | Returns tokens + `onboarding_status` |
| Gender / Age / Languages / City / Goal | `POST /onboarding/*` | Each replies `next_step` |
| Choose avatar | `PUT /me/avatar` | `{ "avatar_id" }` from `GET /avatars` — never an upload |
| Ready | `POST /onboarding/complete` | Re-checks; names the first gap |
| Home feed | `GET /users/discover` | `scope`, filters, pagination |
| City picker | bundled catalogue + `GET /cities/stats` | The list is compiled in; only the counts are fetched |
| Random Call | `POST /users/random-match` → `POST /calls` | Match first, dial second |
| User profile | `GET /users/:id` | Carries `connection_status` |
| Add Friend | `POST /friends/requests` | |
| Chats (two tabs) | `GET /conversations?filter=accepted\|requests` | |
| Chat thread | `GET /conversations/:id` | Opening it marks it read |
| Composer | `POST .../messages` or socket `message:send` | |
| Call screens | socket `call:*` | REST equivalents exist for all |
| Call Ended | `POST /calls/:id/end` | `summary` is what the screen renders |
| Recent | `GET /calls/history` | Rows are per-viewer |
| Profile | `GET /me` | |
| Wallet | `GET /wallet` | Zeros, not nulls, for a friends account |
| Buy Coins | `GET /wallet/packages` → `POST /wallet/purchase` | Server prices it |
| Transactions | `GET /wallet/transactions` | Filtered by role |
| Settings | `GET/PATCH /me/settings/*` | |
| Blocked Users | `GET /moderation/blocked` | |
| Help / Legal | — | Static content stays in the app |

### Empty and error states

The API distinguishes cases the client renders differently:

* Empty feed with `empty_reason: "NO_CALL_TYPES_ENABLED"` — "widen your
  filters" is bad advice when both call types are off.
* `GET /conversations` with messaging off returns an **empty list plus
  `messaging_disabled: true`**, not a 403. The client has a state for it; an
  error would turn a setting into a failure.
* `INSUFFICIENT_COINS` carries `details.required` and `details.balance`, so the
  top-up prompt can name the number.
* `ONBOARDING_INCOMPLETE` carries `details.next_status`, so the client routes
  instead of guessing.

### Enum values

Sent as the exact Dart enum names, because the client resolves them with
`values.byName(...)`: `makeFriends` · `earnMoney` · `online` · `offline` ·
`busy` · `voice` · `video` · `pendingIncoming` · `pendingOutgoing` ·
`accepted` · `coinPurchase` · `withdrawal`.

---

## What the client can stop doing

The audit of the Flutter app found several rules enforced only in the UI. They
are now server-side, and the client's copies become presentation rather than
protection:

* **Coin deduction.** Billed server-side per started minute, on the server's
  clock. A killed client changes nothing.
* **Call eligibility.** Blocked / offline / call-type-off / balance is one
  guard, applied to every entry point including the socket.
* **The friend gate.** Re-checked on every send, not once when a thread opens.
* **Privacy.** A hidden city is *absent from the payload*, not blanked
  client-side. A hidden presence reads as `offline` to everyone but its owner.
* **Blocking.** A full severance — friendship dropped, live call ended,
  pending requests cancelled, and the conversation hidden from both sides'
  chat lists (and unreachable by either — every read and write path re-checks
  the block). The conversation row itself is kept rather than deleted, so
  re-friending later resumes the same thread instead of starting a new one;
  `unfriend` is the action that actually deletes a conversation.

---

## Security

* User identity comes from the **signed token, never the request body**.
* Refresh tokens are stored as SHA-256 digests and **rotate** on every use, so
  a stolen one is good only until its owner next refreshes.
* OTPs are bcrypt-hashed, single-use, and carry their own attempt counter.
  Requesting a new code invalidates the old one.
* Rate limits key OTP endpoints on the **phone number**, not the IP — one
  attacker hitting a hundred numbers is what an IP limit misses.
* Money debits are conditional updates (`coins: { gte: n }`), so two concurrent
  charges cannot both pass a check.
* `Earning.callId` is unique — the constraint *is* the duplicate-payment guard,
  rather than a check that could be raced.
* Errors we did not raise deliberately become a generic 500. Raw messages leak
  table names and query fragments.
* The server refuses to boot — always, not only "in production" — on matching
  JWT secrets, a placeholder secret, an unconfigured or `ws://` LiveKit, a
  missing admin credential, or an admin secret equal to the user one.
  `CORS_ORIGIN=*` and an unset `PAYMENT_PROVIDER` warn rather than stop it.
  `OTP_DEV_MODE` and `PAYMENT_PROVIDER` are deliberately yours to set: nothing
  overrides them by environment, so nothing quietly disagrees with the file.

---

## Tests

All three need the server running, against a database seeded with reference
data (`npm run seed`) — the admin suite additionally needs `ADMIN_USERNAME`
and either `ADMIN_PASSWORD` or `ADMIN_PASSWORD_HASH` configured.

```bash
npm run dev            # terminal one
npm test               # terminal two — runs all three suites
```

| Suite | Checks | Covers |
| --- | --- | --- |
| `tests/e2e.js` | 196 | Sign-up → onboarding → discovery → requests → chat → calls → billing → privacy → blocking → sessions → account deletion |
| `tests/sockets.js` | 35 | Auth, presence, live messaging, typing, read receipts, call signalling, wallet pushes |
| `tests/admin.js` | 50 | Admin auth and lockout, the dashboard, per-user detail, moderation guards, the audit trail |

They assert on **rules**, not status codes: that a stranger cannot be messaged,
that coins actually leave the caller's wallet and arrive as the earner's
pending balance, that blocking severs a conversation, that an outsider cannot
inject into someone else's call.

All three were written before they passed, and caught real bugs — a domain
error code beginning with "P" being swallowed by the Prisma-error heuristic,
and a short call charging the caller while paying the earner nothing.

---

## Docker

A three-stage `Dockerfile` builds a lean, non-root production image —
`build` generates the Prisma client against the image's own OS and libc and
also doubles as the migration image (below); `deps` is an independent,
production-only `npm install` that never pulls in the Prisma CLI's own large
tree of tooling in the first place; `runtime` is `deps`'s `node_modules` plus
`src/`, nothing else.

```bash
docker build -t vybli-backend .

docker run -d --name vybli-backend -p 4000:4000 \
  -e NODE_ENV=production \
  -e DATABASE_URL="postgresql://user:pass@host:5432/vybli" \
  -e JWT_SECRET="…" -e JWT_REFRESH_SECRET="…" \
  -e CORS_ORIGIN="https://app.example.com" \
  -e PAYMENT_PROVIDER=google_play \
  -e LIVEKIT_URL="wss://…" -e LIVEKIT_API_KEY="…" -e LIVEKIT_API_SECRET="…" \
  -e ADMIN_USERNAME="…" -e ADMIN_PASSWORD_HASH="…" -e ADMIN_JWT_SECRET="…" \
  vybli-backend
```

Secrets are never baked into the image — `.env` is excluded by
`.dockerignore` on purpose — so every value above is supplied at `docker run`
time, the same way any orchestrator's secret store would inject them. Every
guard in `config/env.js` is on unconditionally — there is no `NODE_ENV` that
turns them on or relaxes them — so the container refuses to boot if any of the
above are missing, a placeholder, or otherwise unsafe (see
[Security](#security)).

`vybli-backend`, the image above, never carries the Prisma CLI — it lives in
`devDependencies` and stays out of `runtime`'s `node_modules` entirely, since
the running server never calls it. Migrations are a separate image, built
from the `build` stage on its own, which does have it:

```bash
docker build --target build -t vybli-backend:migrate .

docker run --rm --env DATABASE_URL="…" vybli-backend:migrate npx prisma migrate deploy
```

Run that once per release, before traffic reaches the new `vybli-backend`
containers — never automatically on every container start, which would race
across replicas.

The `vybli-backend` image publishes port 4000 and a `HEALTHCHECK` against
`GET /api/v1/health` (the same endpoint a load balancer should poll — it
verifies the database round trip, not just that the process is alive).

---

## Known limits

Honest about what is stubbed, and where the seam is:

| Area | State | Seam |
| --- | --- | --- |
| SMS | Codes logged; returned in dev | `deliver()` in `otp.service.js` |
| Payments | `PAYMENT_PROVIDER=none` credits the wallet directly with **no payment taken**, wherever it runs — set a real provider before strangers can reach it | `purchase()` in `wallet.service.js` |
| Payouts | Recorded `pending`, never settled | `withdraw()` in `wallet.service.js` |
| Media | URLs stored, nothing uploaded | Attachment fields on `Message` |
| WebRTC | Signalling relayed; no TURN | `call:signal` handler |

**Scaling.** Per-minute billing timers are in-process, so a multi-instance
deployment needs them behind a shared store (Redis, or a job queue keyed on
call id), and Socket.IO needs its Redis adapter. Everything else is stateless
and horizontally scalable as it stands.

**Maturing earnings** are released on read rather than by a scheduler, so a
deployment with no cron still behaves correctly. A nightly job calling
`releaseMaturedEarnings` would only make it prompter.
