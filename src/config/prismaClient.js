'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

/**
 * `DATABASE_URL`, read directly rather than through `./env`.
 *
 * `env.js` validates the *whole* application's configuration — JWT secrets,
 * admin credentials, storage, LiveKit — all required unconditionally,
 * because a running server needs every one of them. A seed script needs
 * exactly one of those: a Postgres connection string. Importing `env.js`
 * here would mean `docker run vybli-backend:migrate node prisma/seed.js` —
 * which only ever gets `DATABASE_URL` — failing on a missing `JWT_SECRET`
 * that has nothing to do with seeding reference data.
 */
function databaseUrl() {
  const value = process.env.DATABASE_URL;
  if (!value || !value.trim()) {
    throw new Error(
      'Missing required environment variable DATABASE_URL. Copy .env.example to .env and fill it in.'
    );
  }
  return value.trim();
}

/**
 * Builds a Prisma Client wired to Postgres through the driver adapter Prisma
 * 7 requires.
 *
 * `schema.prisma`'s own `datasource` block no longer carries a connection
 * URL — see the comment there — so a client built with no arguments has no
 * way to reach the database at all and throws on the first query. This is
 * the one place that gap is closed.
 *
 * A factory rather than a single shared export: `config/prisma.js` uses this
 * to build the one client the running server uses, and the seed scripts and
 * the test suites' own out-of-band queries (`prisma/seed.js`,
 * `tests/e2e.js`, etc.) each want their own short-lived client rather than
 * reaching into the app's singleton — but the adapter wiring itself must
 * still be correct in exactly one place, not copied into every one of them.
 */
function createPrismaClient(options = {}) {
  const adapter = new PrismaPg({ connectionString: databaseUrl() });
  return new PrismaClient({ adapter, ...options });
}

module.exports = { createPrismaClient };
