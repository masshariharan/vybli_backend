#!/bin/sh
set -e

# Applies whatever migrations Postgres doesn't have yet, then hands off to
# the real command. A no-op in milliseconds when nothing is pending — see
# the Dockerfile's own comment for why this runs here instead of as a
# separate manual step.
npx prisma migrate deploy

# Then the rows the product cannot sell anything without.
#
# `seed.js` holds the recharge packages and VIP plans as constants, and nothing
# else in the system writes those tables — there is no admin endpoint and no
# panel screen for them. They are code-owned prices that happen to be stored in
# Postgres, so the deployed image's prices ARE the correct prices, and every
# write in there is an upsert keyed on a fixed id. Running it on each boot
# converges the database onto whatever this build declares, which is the only
# behaviour that is right on a fresh environment and on an existing one alike.
#
# It ran nowhere before. `npm run seed` was a manual step, and a manual step is
# the one that gets forgotten: the deployed database was never seeded at all, so
# `GET /wallet/packages` answered `200` with an empty list and the recharge
# screen had nothing to offer.
#
# **Deliberately not fatal.** A failure here is logged loudly and the server
# still starts. Migrations are different — a schema the code disagrees with is
# unserveable — but an empty price list is a wallet that cannot take money,
# while chat, calls, discovery and sign-in are all still perfectly good. Taking
# the whole API down over it would turn a degraded wallet into an outage. The
# app renders an honest "recharge unavailable" for exactly this state.
#
# It also makes a second replica booting at the same moment harmless: whichever
# one loses the race to create a row sees a unique-constraint error, says so,
# and carries on with the row that is now there either way.
node prisma/seed.js || echo "[boot] seeding failed — recharge and VIP will have nothing to offer until it succeeds. The API is starting anyway; see the error above."

# Replaces this shell with the real process so it becomes PID 1 and receives
# Docker's signals directly, rather than staying a child of this script.
exec "$@"
