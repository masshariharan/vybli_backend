# syntax=docker/dockerfile:1

# Vybli backend — production image.
#
# Three stages:
#
#   `build`    Has everything: the full dependency tree — the Prisma CLI
#              included — the schema, and the generated client. Feeds `deps`
#              below.
#
#   `deps`     A second, independent `npm install` — not a copy-then-delete
#              of `build`'s — that skips only what `runtime` truly never
#              touches. This is the stage that actually keeps the final
#              image lean; see the note above `RUN npm ci` below for why a
#              copy-then-prune approach does not.
#
#   `runtime`  The long-running server process, plus the one thing it must
#              run before it dares to: `npx prisma migrate deploy`. No build
#              tools, no test suite, no `.env` — but the Prisma CLI and the
#              migrations directory ARE here, on purpose (see the entrypoint
#              at the bottom of this file for why).
#
# Migrations used to be a separate, manual step — build the `build` stage on
# its own and run `npx prisma migrate deploy` against it once per release,
# before traffic reached the new containers. In practice that manual step is
# the one that gets forgotten: a fresh database wired up and deployed against
# with nobody having run it first crashes on the very first query, and by
# design there was no way to run it externally either — Railway's own
# `DATABASE_URL` points at a private, in-network hostname
# (`postgres.railway.internal`) that a local machine cannot reach at all. The
# container itself, running inside that same network, can — so it does, every
# time it starts, before `node src/server.js` ever runs. `migrate deploy` is
# idempotent: a boot with nothing pending is a no-op measured in
# milliseconds.

ARG NODE_VERSION=22-bookworm-slim

FROM node:${NODE_VERSION} AS build

# The query engine Prisma generates links against libssl; Debian's "slim"
# variant does not ship it by default.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so this layer only rebuilds when package*.json changes —
# not on every source edit.
COPY package.json package-lock.json ./
RUN npm ci

# The schema and the config file are all `prisma generate` needs; the rest
# of the source is irrelevant to it and copying it later keeps this layer
# cache-friendly. No DATABASE_URL required here — generating the client
# reads the schema's shape, not the database itself, and prisma.config.js
# falls back to an empty string rather than insisting on one.
COPY prisma ./prisma
COPY prisma.config.js ./
RUN npx prisma generate

# `src/` is not `prisma generate`'s concern, but running this stage directly
# still wants it: `docker build --target build -t vybli-backend:tools .` then
# `docker run --rm --env DATABASE_URL="…" vybli-backend:tools node
# prisma/seed.js` is the way to run a one-off script — the seeders, a
# manual `prisma studio` — against a real database without shipping either
# into `runtime`. `prisma/seed.js` and `prisma/seed-demo.js` build their
# client through `src/config/prismaClient.js` like everything else does (see
# that file's own comment), so this needs `src/` on disk to resolve that
# `require`.
COPY src ./src


FROM node:${NODE_VERSION} AS deps

WORKDIR /app
COPY package.json package-lock.json ./

# The install `runtime` actually ships, and the reason this is its own `npm
# ci` rather than `COPY --from=build` followed by `npm prune`: a Docker layer
# that is later deleted by a `RUN rm` in a *different* layer is not gone from
# the image, it is hidden — the bytes are still stored, because a layer is a
# diff, not a checkpoint. Installing the pruned set fresh, in a stage nothing
# ever copies wholesale, is what actually keeps them out.
#
# `--omit=dev` only: the Prisma CLI is listed as an *optional peer* of
# `@prisma/client` rather than a `devDependency`, which is what actually
# pulls it in here — deliberately, since `runtime` below now needs it to run
# `prisma migrate deploy` at boot. (An earlier version of this image also
# passed `--omit=optional` to exclude it; that shrank the image but is what
# left migrations with no way to run inside the deployed container at all.)
RUN npm ci --omit=dev

# The one thing this fresh install cannot produce on its own: the generated
# client's engine binary, which only exists once `prisma generate` has run
# against a real schema. Copied in from `build` rather than regenerated here
# a second time — `deps` never even has a copy of `prisma/schema.prisma` to
# generate one from, on purpose, since nothing at runtime needs it once the
# client exists.
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma


FROM node:${NODE_VERSION} AS runtime

# The engine binary `deps` copied in links against libssl at runtime, same
# as it did to generate at build time.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

# The official image's built-in unprivileged user — running as root inside a
# container is a needless privilege to hand to whatever this dependency tree
# might one day contain a bug in.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

# What `prisma migrate deploy` needs at boot: the migrations to apply, the
# schema so the CLI knows where to find them, and the config Prisma 7 reads
# the datasource URL from (see prisma.config.js's own comment for why the
# URL no longer lives in schema.prisma itself).
COPY --chown=node:node prisma ./prisma
COPY --chown=node:node prisma.config.js ./
COPY --chown=node:node docker-entrypoint.sh ./
# Checked out on Windows, the executable bit does not survive — set it
# explicitly rather than trust git/COPY to have preserved it.
RUN chmod +x ./docker-entrypoint.sh

USER node

EXPOSE 4000

# Exercises the same endpoint a load balancer or orchestrator would, which
# itself checks the database round trip, not just that the process is alive.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "\
    const p = process.env.PORT || 4000; \
    require('http').get({ host: '127.0.0.1', port: p, path: '/api/v1/health', timeout: 4000 }, (res) => { \
      process.exit(res.statusCode === 200 ? 0 : 1); \
    }).on('error', () => process.exit(1));"

# The entrypoint runs the migration, then `exec`s node in its own place —
# node becomes PID 1 for the rest of the container's life, so Docker's
# SIGTERM still reaches it directly and server.js's own graceful-shutdown
# handler still runs, exactly as it did calling node directly before.
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
