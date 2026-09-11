'use strict';

const { createPrismaClient } = require('./prismaClient');
const env = require('./env');

/**
 * One client for the whole process.
 *
 * Kept on `globalThis` in development so nodemon's reloads reuse the same
 * pool — without this each restart opens another one and Postgres runs out of
 * connections after a dozen saves.
 */
const prisma =
  globalThis.__vybliPrisma ??
  createPrismaClient({
    log: env.isProduction ? ['warn', 'error'] : ['warn', 'error'],
  });

if (!env.isProduction) globalThis.__vybliPrisma = prisma;

module.exports = prisma;
