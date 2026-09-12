'use strict';

const http = require('http');

const env = require('./config/env');
const prisma = require('./config/prisma');
const { createApp } = require('./app');
const { attachSockets } = require('./sockets');
const profileService = require('./services/profile.service');
const callService = require('./services/call.service');

/**
 * Process entry point.
 *
 * Boot does two pieces of reconciliation before accepting traffic. A crash
 * leaves rows describing a world that no longer exists — users marked `online`
 * with no socket, calls stuck at `connected` with nobody on them — and serving
 * those to a client is worse than a moment's delay: someone would appear
 * callable and never answer, and a stuck call would block its owner from ever
 * placing another.
 */
async function start() {
  const app = createApp();
  const server = http.createServer(app);

  attachSockets(server);

  const [presenceReset, callsClosed] = await Promise.all([
    profileService.resetAllPresence(),
    callService.reconcileOnBoot(),
  ]);

  if (presenceReset > 0) {
    console.info(`[boot] reset ${presenceReset} stale presence rows to offline`);
  }
  if (callsClosed > 0) {
    console.info(`[boot] closed ${callsClosed} calls left open by a previous run`);
  }

  // No host argument, so this binds every interface — loopback and the LAN
  // alike. That is what lets a phone on the same Wi-Fi reach it.
  server.listen(env.port, () => {
    console.info(`[boot] Vybli API listening on http://localhost:${env.port}`);
    console.info(`[boot] REST at /api/v1 — Socket.IO on the same port`);

    // The LAN addresses, printed because `localhost` is the one address that
    // is useless to every device except this one. A phone needs the address
    // below, and having to go and find it by hand is how builds end up
    // pointing at `localhost` and failing with nothing to explain why.
    for (const address of lanAddresses()) {
      console.info(`[boot] reachable from this network at http://${address}:${env.port}`);
    }

    // `npm start` runs plain node, so the process serves whatever the code
    // looked like when it launched — edit a file and nothing changes, which
    // is indistinguishable from a bug in the code you just wrote, because the
    // code you just wrote is not running. Worth naming whenever it's true,
    // not just while "developing": nodemon sets this variable in the child it
    // spawns, so its absence means exactly this, wherever it happens.
    if (!process.env.__NODEMON_RUNNING) {
      console.warn(
        '[boot] no auto-reload — started with `npm start`. Edits will NOT take effect ' +
          'until this process is restarted. Use `npm run dev` (nodemon) while iterating.'
      );
    }
  });

  setupShutdown(server);
  return server;
}

/**
 * This machine's LAN IPv4 addresses.
 *
 * Internal only, and never used to build a URL the server hands out — DHCP
 * reassigns these, and a phone, an emulator and a browser all reach this same
 * process by different addresses. It is printed so a human can read it, and
 * that is all.
 */
function lanAddresses() {
  const os = require('os');
  const found = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      // Virtual adapters — WSL, Docker, VPNs — have addresses that look
      // perfectly plausible and are reachable from nothing.
      if (/vEthernet|WSL|Loopback|Docker/i.test(name)) continue;
      found.push(entry.address);
    }
  }
  return found;
}

/**
 * Shuts down in the right order: stop accepting, finish what is in flight,
 * then close the pool. Killing the database first would fail the very requests
 * the grace period exists to protect.
 */
function setupShutdown(server) {
  let closing = false;

  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.info(`[shutdown] ${signal} — closing`);

    server.close(() => console.info('[shutdown] http closed'));

    try {
      // Mark everyone offline: their sockets are about to drop and the rows
      // would otherwise say online until each client notices.
      await profileService.resetAllPresence();
      await prisma.$disconnect();
      console.info('[shutdown] database disconnected');
    } catch (err) {
      console.error('[shutdown] failed', err);
    }

    // A stuck close should not hold the process open forever.
    setTimeout(() => process.exit(0), 5_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    console.error('[fatal] unhandled rejection', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[fatal] uncaught exception', err);
    shutdown('uncaughtException');
  });
}

if (require.main === module) {
  start().catch((err) => {
    console.error('[boot] failed to start', err);
    process.exit(1);
  });
}

module.exports = { start };
