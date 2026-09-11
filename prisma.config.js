'use strict';

require('dotenv').config();

const { defineConfig } = require('prisma/config');

/**
 * Where the Prisma CLI gets what used to live in `schema.prisma`'s own
 * `datasource` block.
 *
 * As of Prisma 7 the schema file no longer carries a connection URL — see the
 * `datasource` comment in `prisma/schema.prisma` for why, and
 * `src/config/prismaClient.js` for how the *running application* connects
 * (a driver adapter, constructed there, not read from here: this file is
 * CLI-only — `generate`, `migrate`, `studio`, `db seed` — and is never
 * imported by the server process).
 *
 * Plain CommonJS rather than `prisma.config.ts`: this project has no
 * TypeScript anywhere else, and Prisma's config loader accepts `.js` equally
 * — there is nothing a `.ts` file would buy here.
 *
 * Read from `process.env` directly rather than through `prisma/config`'s own
 * `env()` helper: that helper throws the moment this file loads if the
 * variable is missing, and `prisma generate` — which needs the *shape* of the
 * schema, never a database connection — has no reason to require one. A
 * Docker build stage runs exactly that command with no `DATABASE_URL` in
 * sight, and did, until this line stopped insisting on one. `migrate deploy`
 * and everything else that genuinely needs a live connection still fails in
 * the usual way, from Postgres itself, when the string is missing or wrong.
 */
module.exports = defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'node prisma/seed.js',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
});
