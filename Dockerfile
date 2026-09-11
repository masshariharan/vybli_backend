# syntax=docker/dockerfile:1

# Vybli backend — production image.
#
# Three stages, and they exist for three different reasons rather than one
# being a throwaway step before the next:
#
#   `build`    Has everything: the full dependency tree — the Prisma CLI
#              included — the schema, and the generated client. Besides
#              feeding `deps` below, this stage is itself the image to use
#              for the one operational command a running server never issues
#              on its own: `npx prisma migrate deploy`. Build it on its own
#              with `docker build --target build -t vybli-backend:migrate .`,
#              then run that tag once per release, before traffic reaches
#              the new containers:
#                docker run --rm --env DATABASE_URL="…" \
#                  vybli-backend:migrate npx prisma migrate deploy
#
#   `deps`     A second, independent `npm install` — not a copy-then-delete
#              of `build`'s — that never installs the packages `runtime` has
#              no use for in the first place. This is the stage that actually
#              keeps the final image small; see the note above `RUN npm ci`
#              below for why a copy-then-prune approach does not.
#
#   `runtime`  The long-running server process and nothing it does not touch:
#              `deps`'s lean node_modules, `src/`. No build tools, no CLI, no
#              schema file, no test suite, no `.env`.
#
# The three-way split is worth the extra stage specifically because of
# Prisma 7: the CLI package pulls in a large tree of its own tooling — config
# loading, database drivers this project never uses, a bundled UI framework
# for Studio — that a running server has no use for, and Prisma installs it
# as an *optional peer* of `@prisma/client` rather than a devDependency, so
# `npm prune --omit=dev` alone does not remove it.

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

# `src/` is not `prisma generate`'s concern, but it is the migrator image's:
# `prisma/seed.js` and `prisma/seed-demo.js` build their client through
# `src/config/prismaClient.js` like everything else does (see that file's
# own comment), so a `docker run vybli-backend:migrate node prisma/seed.js`
# needs it on disk to resolve that `require`.
COPY src ./src

# Deliberately not pruned: this stage doubles as the migrator image (see the
# comment at the top of this file), and the CLI that would remove is the one
# thing that image exists to run.


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
# `--omit=optional` beyond `--omit=dev` is the one non-obvious flag: Prisma
# lists the CLI as an *optional peer* of `@prisma/client`, which is neither a
# `dependency` nor a `devDependency` in the sense either `--omit` flag alone
# would catch, and it is what pulls in the bulk of the tooling `build`'s
# `node_modules` carries that this stage's does not.
RUN npm ci --omit=dev --omit=optional

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

# Production refuses to boot with STORAGE_DRIVER=local (config/env.js), so a
# real deployment never touches this. It is created anyway, owned by `node`,
# because `WORKDIR /app` itself is root-owned — a non-production run of this
# same image (STORAGE_DRIVER left at its "local" default, say in a staging
# environment with no S3 bucket yet) would otherwise crash at boot on
# `mkdir '/app/uploads'`, EACCES, the moment app.js tried to create it itself.
RUN mkdir -p uploads && chown node:node uploads

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

# Exec form, invoking node directly rather than through `npm start`: Docker
# sends SIGTERM to PID 1, and server.js's own graceful-shutdown handler —
# stop accepting, mark everyone offline, close the pool — only runs if that
# signal reaches the node process itself rather than being absorbed by an
# intermediate npm process.
CMD ["node", "src/server.js"]
