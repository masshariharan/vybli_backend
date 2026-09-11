'use strict';

const { EventEmitter } = require('events');

/**
 * One-way channel from the services to the socket layer.
 *
 * A service that accepts a friend request needs to push it to the other
 * person's phone, but importing the Socket.IO server into the service would
 * make the dependency circular — the socket handlers call the same services.
 * Services emit here instead and the socket layer subscribes, so the domain
 * logic stays testable without a running server and works identically whether
 * the caller arrived over REST or over a socket.
 */
const bus = new EventEmitter();

// Generous: a popular user can have many concurrent listeners attached.
bus.setMaxListeners(50);

/** Every event name, so a typo is a missing constant rather than dead silence. */
const RealtimeEvent = {
  /** { userId, payload } — deliver to one person's devices. */
  TO_USER: 'toUser',
  /** { userIds: [], payload } — deliver to several. */
  TO_USERS: 'toUsers',
  /** { userId, status } — presence changed and watchers should know. */
  PRESENCE: 'presence',

  /**
   * { event, data } — something happened worth showing the administrator.
   *
   * A separate channel rather than a user id of "admin": these are
   * *platform* events, and the admin panel wants the ones no single user
   * would receive — a new sign-up, a call starting between two other people,
   * a report being filed.
   */
  TO_ADMIN: 'toAdmin',
};

/** Sends `payload` to every socket belonging to `userId`. */
function emitToUser(userId, event, data) {
  bus.emit(RealtimeEvent.TO_USER, { userId, event, data });
}

function emitToUsers(userIds, event, data) {
  bus.emit(RealtimeEvent.TO_USERS, { userIds, event, data });
}

/**
 * Tells the admin panel something happened.
 *
 * Fire-and-forget, and nothing in the product depends on it: an admin browser
 * that is closed, or a deployment with no panel open, must change nothing
 * about how the platform behaves.
 */
function emitToAdmin(event, data) {
  bus.emit(RealtimeEvent.TO_ADMIN, { event, data });
}

module.exports = { bus, RealtimeEvent, emitToUser, emitToUsers, emitToAdmin };
