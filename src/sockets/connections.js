'use strict';

/**
 * Which accounts have a live socket on this instance, right now.
 *
 * `UserProfile.presence` is a *cache* of this, and caches drift: a call ending
 * used to write `online` for both sides unconditionally, so a callee who had
 * never been connected at all came out of a missed call advertised as online
 * until something else happened to touch the column. Anything that has to
 * decide "is this person actually reachable" — ringing a phone, restoring
 * presence after a call — asks here instead of reading the column back.
 *
 * Maintained synchronously by the socket layer on `connection`/`disconnect`,
 * so there is no await between a socket dropping and this knowing about it.
 *
 * Same scaling note as the call timers: in-process, so a multi-instance
 * deployment needs this moved to the adapter (`fetchSockets` across nodes) or
 * a shared store.
 */

/** userId → Set of socket ids. */
const socketsByUser = new Map();

function add(userId, socketId) {
  let set = socketsByUser.get(userId);
  if (!set) {
    set = new Set();
    socketsByUser.set(userId, set);
  }
  set.add(socketId);
}

/** Returns how many sockets this account still has open after removing this one. */
function remove(userId, socketId) {
  const set = socketsByUser.get(userId);
  if (!set) return 0;
  set.delete(socketId);
  if (set.size === 0) socketsByUser.delete(userId);
  return set.size;
}

function isConnected(userId) {
  return (socketsByUser.get(userId)?.size ?? 0) > 0;
}

/** How many sockets `userId` has open — one per device with the app open. */
function socketCount(userId) {
  return socketsByUser.get(userId)?.size ?? 0;
}

/** How many accounts have the app open and connected right now. */
function connectedUserCount() {
  return socketsByUser.size;
}

module.exports = { add, remove, isConnected, socketCount, connectedUserCount };
