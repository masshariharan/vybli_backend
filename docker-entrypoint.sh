#!/bin/sh
set -e

# Applies whatever migrations Postgres doesn't have yet, then hands off to
# the real command. A no-op in milliseconds when nothing is pending — see
# the Dockerfile's own comment for why this runs here instead of as a
# separate manual step.
npx prisma migrate deploy

# Replaces this shell with the real process so it becomes PID 1 and receives
# Docker's signals directly, rather than staying a child of this script.
exec "$@"
