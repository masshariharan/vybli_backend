'use strict';

const { Server } = require('socket.io');
const prisma = require('../config/prisma');
const env = require('../config/env');
const { verifyAccessToken } = require('../utils/tokens');
const { bus, RealtimeEvent } = require('./bus');
const profileService = require('../services/profile.service');
const chatService = require('../services/chat.service');
const callService = require('../services/call.service');
const relationship = require('../services/relationship.service');
const serialize = require('../utils/serialize');
const adminAuth = require('../services/admin/auth.service');
const connections = require('./connections');

/**
 * The real-time layer.
 *
 * Two things travel over sockets rather than HTTP: **presence**, which is a
 * property of being connected and cannot be modelled by polling, and
 * **signalling** — a message or a ringing phone has to arrive without being
 * asked for.
 *
 * Everything a socket event does goes through the same services the REST
 * routes use. That is deliberate: a rule enforced in a controller and
 * forgotten in a socket handler is a rule that does not exist, and a client
 * can always choose the weaker path.
 *
 * Each user joins a room named after their id, so "tell this person" is one
 * emit regardless of how many devices they have open.
 */

const roomFor = (userId) => `user:${userId}`;

/**
 * Presence subscriptions: watched userId → Set of watching socket ids, and
 * the reverse, so a socket's watches can be dropped when it goes.
 * See `presence:watch`.
 */
const watchersOf = new Map();
const watchedBy = new Map();

/** Most ids one socket may watch at once — a screenful of cards, generously. */
const MAX_WATCHED = 200;

function unwatchAll(socketId) {
  for (const id of watchedBy.get(socketId) ?? []) {
    const set = watchersOf.get(id);
    if (!set) continue;
    set.delete(socketId);
    if (set.size === 0) watchersOf.delete(id);
  }
  watchedBy.delete(socketId);
}

function attachSockets(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: env.corsOrigin.includes('*') ? true : env.corsOrigin,
      credentials: true,
    },
    // How quickly a phone that lost its network is noticed. Nothing on the
    // wire says "my signal just died" — the socket simply goes quiet — so
    // the heartbeat is the only detector, and it sets how long that person
    // keeps showing "Online" and how long a call to them keeps claiming to
    // ring. It was 25s + 30s, nearly a minute of "Online" for a phone in a
    // tunnel. 10s + 10s notices within ~20s at the cost of a few bytes a
    // phone sends anyway; a wifi-to-cellular switch still reconnects, it just
    // does so as a new socket.
    pingTimeout: 10_000,
    pingInterval: 10_000,
  });

  // ── Authentication ────────────────────────────────────────────────────────
  // Same token as REST, checked before the connection is accepted rather than
  // on the first event — an unauthenticated socket should never exist.
  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.replace(/^Bearer /, '');

      if (!token) return next(new Error('UNAUTHORIZED'));

      const payload = verifyAccessToken(token);
      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        include: {
          profile: true,
          privacySettings: true,
          // The sign-in this token belongs to — see the same check in
          // `middleware/auth`. A handshake is authenticated once and never
          // re-checked, so letting a revoked session open a socket would be
          // the one door left open after the account moved to another device.
          ...(payload.sid
            ? {
                sessions: {
                  where: { id: payload.sid },
                  select: { id: true, revokedAt: true, expiresAt: true },
                },
              }
            : {}),
        },
      });

      if (!user || user.deletedAt || user.status !== 'active') {
        return next(new Error('UNAUTHORIZED'));
      }

      if (payload.sid) {
        const session = user.sessions?.[0];
        if (!session || session.revokedAt || session.expiresAt < new Date()) {
          return next(new Error('UNAUTHORIZED'));
        }
      }

      socket.userId = user.id;
      socket.user = user;
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.userId;
    socket.join(roomFor(userId));
    // Synchronously, before anything awaits: from this instant on, anything
    // asking "can this person be rung / are they online" must hear yes.
    connections.add(userId, socket.id);

    handleConnect(io, socket).catch((err) =>
      console.error('[socket] connect failed', err)
    );

    registerPresence(io, socket);
    registerChat(io, socket);
    registerCalls(io, socket);

    socket.on('disconnect', () => {
      unwatchAll(socket.id);
      handleDisconnect(io, socket).catch((err) =>
        console.error('[socket] disconnect failed', err)
      );
    });
  });

  // ── Bridge from the services ──────────────────────────────────────────────
  bus.on(RealtimeEvent.TO_USER, ({ userId, event, data }) => {
    io.to(roomFor(userId)).emit(event, data);
  });
  bus.on(RealtimeEvent.TO_USERS, ({ userIds, event, data }) => {
    for (const id of userIds) io.to(roomFor(id)).emit(event, data);
  });
  bus.on(RealtimeEvent.TO_PRESENCE_WATCHERS, ({ userId, event, data }) => {
    const socketIds = watchersOf.get(userId);
    if (socketIds?.size) io.to([...socketIds]).emit(event, data);
  });

  // A session that is over takes its sockets with it. `disconnectSockets`
  // closes them from this side rather than asking the client to, because the
  // reason for closing is usually that this client is no longer one we accept
  // instructions from.
  //
  // A beat later, though, and that delay is the point. The explanation —
  // `session:revoked`, which is what puts the displaced phone on its login
  // screen — is emitted immediately before this over the very connection this
  // closes. Closing it in the same tick races the write: the client would lose
  // the one message telling it why, and be left to work it out from the next
  // request it happened to make. Long enough to flush, short enough that a
  // client ignoring the event is still cut off promptly.
  bus.on(RealtimeEvent.DISCONNECT_USER, ({ userId, reason }) => {
    console.info(`[socket] dropping ${userId}'s connections: ${reason}`);
    setTimeout(() => {
      io.in(roomFor(userId)).disconnectSockets(true);
    }, 1_000).unref();
  });

  attachAdminNamespace(io);

  return io;
}

/** Marks the user online and sends them what they missed. */
async function handleConnect(io, socket) {
  const userId = socket.userId;

  // Unconditionally, and from the truth rather than a guess — `busy` if a call
  // is still live, `online` otherwise. See `callService.syncPresence`: it is
  // what keeps this write and a racing disconnect's from landing out of
  // order and leaving a connected phone marked offline. Idempotent, so a
  // second device connecting announces nothing.
  await callService.syncPresence(userId);

  // Everything below is a convenience; the `connected` event itself is not.
  //
  // The client treats that event as the moment it may believe presence again
  // — until it arrives, it renders every account as offline, because a device
  // that cannot hear the server cannot honestly claim to know who is online.
  // So a transient failure reading an unread count or a stale call row must
  // not withhold it: the connection is real either way, and swallowing the
  // event over an unread badge left a perfectly connected phone insisting
  // that nobody was online.
  let unread = { total: 0 };
  let activeCall = null;
  try {
    [unread, activeCall] = await Promise.all([
      chatService.unreadSummary(socket.user),
      callService.getActive(userId),
      // Everything still sitting at `sent` for this user, across every
      // conversation, becomes `delivered` the moment they have a socket
      // again — this is the only place a message sent while they were
      // fully offline ever gets revisited.
      chatService.markDelivered(socket.user).catch((err) => {
        console.error('[socket] delivery sweep failed for', userId, err.message);
      }),
    ]);
  } catch (err) {
    console.error('[socket] could not read the backlog for', userId, err.message);
  }

  // A call still ringing *at* this user. Calls only ever ring someone already
  // connected, and a ring whose callee drops is ended on the spot (see
  // `handleDisconnect`) — so this is another of their devices opening while
  // the first one rings. It rings here too; whichever device answers first
  // takes the call, and the others stand down (see the app's
  // `CallController.onConnectedRemotely`).
  const ringHere =
    activeCall && activeCall.calleeId === userId && activeCall.status === 'ringing';

  // A client that restarted mid-call rejoins it instead of losing it — with
  // fresh media credentials, so it rejoins the conversation and not just the
  // screen. Minting those talks to LiveKit, so it gets the same treatment.
  let media = null;
  // Whatever this call's in-call chat holds so far — a socket drop and
  // reconnect must not read as the other person going quiet, the same way
  // the call itself did not end just because this device's connection did.
  let callMessages = [];
  if (activeCall) {
    try {
      media = await callService.withMedia(activeCall, userId);
      callMessages = callService.recentMessages(activeCall.id);
      // Same event a live ring sends, so this socket needs no code path of
      // its own to show the incoming-call screen — it is just late.
      if (ringHere) socket.emit('call:incoming', media);
    } catch (err) {
      console.error('[socket] could not restore call media for', userId, err.message);
    }
  }

  socket.emit('connected', {
    user_id: userId,
    unread,
    active_call: media,
    call_messages: callMessages,
  });
}

/**
 * Marks the user offline once their last device goes — and releases any call
 * they were in, so nobody is left "on another call" with a person who is gone.
 *
 * A live call is ended. Leaving a call `connected` after the caller vanished
 * would bill them for silence — the billing ticker does not care that nobody
 * is listening.
 *
 * A call still *ringing* is treated by side. A caller who drops has hung up —
 * cancelled. A callee who drops can no longer be rung: calls are real-time
 * only, so the ring ends now as `unavailable` rather than waiting out its
 * timeout for a phone that is not coming back in time.
 */
async function handleDisconnect(io, socket) {
  const userId = socket.userId;

  // Synchronous, so a reconnect that lands during the awaits below is seen by
  // everything after it — `syncPresence` reads this again when it runs.
  if (connections.remove(userId, socket.id) > 0) return; // Another device is still on.

  const activeCall = await callService.getActive(userId);
  if (activeCall && !connections.isConnected(userId)) {
    const ringingAtMe = activeCall.status === 'ringing' && activeCall.calleeId === userId;
    if (ringingAtMe) {
      await callService.abandonRing(activeCall.id).catch(() => {});
    } else {
      await callService
        .end({ id: userId }, activeCall.id, { reason: 'networkError', force: true })
        .catch(() => {});
    }
  }

  await callService.syncPresence(userId);
}

// ── Presence ────────────────────────────────────────────────────────────────

function registerPresence(io, socket) {
  /** Explicit override — going invisible without dropping the connection. */
  socket.on('presence:set', async ({ status } = {}, ack) => {
    try {
      if (!['online', 'offline', 'busy'].includes(status)) {
        return ack?.({ success: false, error: 'INVALID_STATUS' });
      }
      await profileService.setPresence(socket.userId, status);
      ack?.({ success: true });
    } catch (err) {
      ack?.({ success: false, error: err.code ?? 'INTERNAL_ERROR' });
    }
  });

  /**
   * "Tell me live when any of these people's presence changes" — the ids on
   * screen right now: Home's cards, an open profile. Replaces this socket's
   * previous watch list outright, so the app just sends whatever it is
   * showing and never has to unwatch.
   *
   * The same people a discovery card or profile already shows presence for,
   * and `setPresence` still says nothing about anyone hiding their status, so
   * this reveals nothing a REST fetch would not — it only stops the answer
   * going stale while the screen is open. Answers with the current status of
   * each so there is no gap between the fetch and the first change.
   */
  socket.on('presence:watch', async ({ user_ids: ids = [] } = {}, ack) => {
    try {
      const wanted = [...new Set(Array.isArray(ids) ? ids : [])]
        .filter((id) => typeof id === 'string' && id !== socket.userId)
        .slice(0, MAX_WATCHED);

      unwatchAll(socket.id);
      if (socket.disconnected) return ack?.({ success: false, error: 'DISCONNECTED' });
      watchedBy.set(socket.id, new Set(wanted));
      for (const id of wanted) {
        let set = watchersOf.get(id);
        if (!set) watchersOf.set(id, (set = new Set()));
        set.add(socket.id);
      }

      const profiles = wanted.length
        ? await prisma.userProfile.findMany({
            where: { userId: { in: wanted } },
            select: {
              userId: true,
              presence: true,
              lastSeen: true,
              user: { select: { privacySettings: { select: { showOnlineStatus: true } } } },
            },
          })
        : [];

      ack?.({
        success: true,
        data: profiles.map((p) => {
          const visible = p.user?.privacySettings?.showOnlineStatus !== false;
          return {
            user_id: p.userId,
            status: visible ? p.presence : 'offline',
            last_seen: visible ? (p.lastSeen?.toISOString() ?? null) : null,
          };
        }),
      });
    } catch (err) {
      ack?.({ success: false, error: err.code ?? 'INTERNAL_ERROR' });
    }
  });

  /**
   * Presence for a set of people — the chat list needs it for every row.
   *
   * Only people with an open conversation are answered. Letting anyone poll
   * presence for an arbitrary id would make "show online status" meaningless
   * to anyone determined.
   */
  socket.on('presence:query', async ({ user_ids: ids = [] } = {}, ack) => {
    try {
      const peerIds = await relationship.conversationPeerIdsFor(socket.userId);
      const allowed = ids.filter((id) => peerIds.has(id) || id === socket.userId);

      const profiles = await prisma.userProfile.findMany({
        where: { userId: { in: allowed } },
        select: {
          userId: true,
          presence: true,
          lastSeen: true,
          user: { select: { privacySettings: { select: { showOnlineStatus: true } } } },
        },
      });

      ack?.({
        success: true,
        data: profiles.map((p) => {
          const visible = p.user?.privacySettings?.showOnlineStatus !== false;
          return {
            user_id: p.userId,
            status: visible ? p.presence : 'offline',
            last_seen: visible ? (p.lastSeen?.toISOString() ?? null) : null,
          };
        }),
      });
    } catch (err) {
      ack?.({ success: false, error: err.code ?? 'INTERNAL_ERROR' });
    }
  });
}

// ── Chat ────────────────────────────────────────────────────────────────────

function registerChat(io, socket) {
  /**
   * Sending over the socket rather than HTTP saves a round trip on the hot
   * path. It runs the identical service call, so every guard applies — a
   * client cannot reach a laxer path by choosing the socket.
   */
  socket.on('message:send', async (payload = {}, ack) => {
    try {
      const { message } = await chatService.sendMessage(
        socket.user,
        payload.conversation_id,
        {
          text: payload.text ?? '',
          attachment: payload.attachment,
          clientId: payload.client_id,
        }
      );
      ack?.({
        success: true,
        data: {
          message: serialize.message(message, socket.userId),
          client_id: payload.client_id ?? null,
        },
      });
    } catch (err) {
      ack?.({
        success: false,
        error: err.code ?? 'INTERNAL_ERROR',
        message: err.message,
      });
    }
  });

  socket.on('message:read', async ({ conversation_id: conversationId } = {}, ack) => {
    try {
      await chatService.markRead(socket.user, conversationId);
      ack?.({ success: true });
    } catch (err) {
      ack?.({ success: false, error: err.code ?? 'INTERNAL_ERROR' });
    }
  });

  /**
   * The client's live ack that it actually rendered a `message:new` — this is
   * the second tick. No ack, no `try/catch` reply expected: a missed delivery
   * ack just means the reconnect sweep in `handleConnect` catches it later.
   */
  socket.on('message:delivered', async ({ message_id: messageId } = {}) => {
    if (!messageId) return;
    try {
      await chatService.markDelivered(socket.user, { messageIds: [messageId] });
    } catch (err) {
      console.error('[socket] message:delivered failed', err);
    }
  });

  /**
   * Typing.
   *
   * Deliberately not persisted — it is worthless a second later. Membership is
   * still checked, or anyone could make a stranger's phone show them typing.
   */
  socket.on('typing', async ({ conversation_id: conversationId, is_typing } = {}) => {
    try {
      const conversation = await chatService.getConversationOr404(
        conversationId,
        socket.userId
      );
      const side = chatService.sideOf(conversation, socket.userId);
      io.to(roomFor(side.peerId)).emit('typing', {
        conversation_id: conversationId,
        user_id: socket.userId,
        is_typing: Boolean(is_typing),
      });
    } catch {
      // A typing indicator is not worth an error round trip.
    }
  });
}

// ── Calls ───────────────────────────────────────────────────────────────────

/**
 * Call control.
 *
 * The service emits `call:incoming`, `call:accepted` and `call:ended` itself,
 * so these handlers only translate the socket event into the same service call
 * the REST route makes. Both paths therefore charge identically — which
 * matters, because the call screen uses sockets and the summary reads what
 * REST wrote.
 */
function registerCalls(io, socket) {
  const wrap = (fn) => async (payload = {}, ack) => {
    try {
      const data = await fn(payload);
      ack?.({ success: true, data });
    } catch (err) {
      ack?.({
        success: false,
        error: err.code ?? 'INTERNAL_ERROR',
        message: err.message,
      });
    }
  };

  socket.on(
    'call:start',
    wrap(async (payload) => {
      const call = await callService.start(socket.user, {
        userId: payload.user_id,
        type: payload.type,
        isRandom: Boolean(payload.is_random),
        clientId: typeof payload.client_id === 'string' ? payload.client_id : undefined,
      });
      return { call: await callService.withMedia(call, socket.userId) };
    })
  );

  /**
   * The app's word that `call:incoming` actually reached it and the phone is
   * ringing — the only thing that turns the caller's "Calling" into
   * "Ringing". See `callService.markRingDelivered`.
   */
  socket.on(
    'call:ring_received',
    wrap(async (payload) => {
      await callService.markRingDelivered(socket.user, payload.call_id);
      return null;
    })
  );

  socket.on(
    'call:accept',
    wrap(async (payload) => {
      const call = await callService.accept(socket.user, payload.call_id);
      return { call: await callService.withMedia(call, socket.userId) };
    })
  );

  socket.on(
    'call:reject',
    wrap(async (payload) => {
      const call = await callService.reject(socket.user, payload.call_id);
      return { call: await callService.withMedia(call, socket.userId) };
    })
  );

  socket.on(
    'call:cancel',
    wrap(async (payload) => {
      const call = await callService.cancel(socket.user, payload.call_id);
      return { call: await callService.withMedia(call, socket.userId) };
    })
  );

  socket.on(
    'call:end',
    wrap(async (payload) => {
      const call = await callService.end(socket.user, payload.call_id, {
        reason: payload.reason ?? 'hungUp',
      });
      return {
        call: await callService.withMedia(call, socket.userId),
        summary: {
          duration_seconds: call.durationSeconds,
          amount_spent: call.callerId === socket.userId ? Number(call.amountSpent) : 0,
          end_reason: call.endReason,
        },
      };
    })
  );

  socket.on(
    'call:message',
    wrap(async (payload) => {
      const message = await callService.sendMessage(
        socket.user,
        payload.call_id,
        payload.text
      );
      return { message };
    })
  );

  // There is deliberately no `call:signal` or `call:media` here any more.
  //
  // Both used to exist: SDP and ICE were relayed through this socket, and mute
  // and camera state were mirrored by hand. LiveKit carries all four now — it
  // is the SFU, so signalling is between each client and LiveKit rather than
  // through us, and a muted track is a property of the track that the other
  // side is already subscribed to.
  //
  // They are gone rather than left in place because two paths for the same
  // state is how the two come to disagree: a client that kept emitting
  // `call:media` would toggle an icon on the far side without touching the
  // audio, and the icon would be a lie.
}

/**
 * The admin panel's live feed.
 *
 * Its own namespace, with its own authentication, for two reasons: an admin
 * token is signed with a different secret and must never be accepted by the
 * user handshake, and the events are platform-wide — a new sign-up, a call
 * between two other people — which no user room would ever carry.
 *
 * Read-only. The namespace emits and accepts nothing; every admin action goes
 * through the REST API, where it is validated and audited. A socket that could
 * suspend an account would be a second, unaudited path to the same power.
 */
function attachAdminNamespace(io) {
  const nsp = io.of('/admin');

  nsp.use((socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.replace(/^Bearer /, '');
      if (!token) return next(new Error('UNAUTHORIZED'));
      socket.admin = adminAuth.verify(token);
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });

  nsp.on('connection', (socket) => {
    socket.emit('admin:connected', { at: new Date().toISOString() });
  });

  bus.on(RealtimeEvent.TO_ADMIN, ({ event, data }) => {
    nsp.emit(event, data);
  });

  return nsp;
}

module.exports = { attachSockets, roomFor };
