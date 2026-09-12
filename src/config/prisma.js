'use strict';

const { createPrismaClient } = require('./prismaClient');

/**
 * One client for the whole process.
 *
 * Kept on `globalThis` under nodemon so its reloads reuse the same pool —
 * without this each restart opens another one and Postgres runs out of
 * connections after a dozen saves. `node src/server.js` directly (no
 * nodemon) only ever creates this once anyway, so there is nothing to reuse.
 */
const prisma = globalThis.__vybliPrisma ?? createPrismaClient({ log: ['warn', 'error'] });

if (process.env.__NODEMON_RUNNING) globalThis.__vybliPrisma = prisma;

module.exports = prisma;
