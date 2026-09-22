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

function attachSockets(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: env.corsOrigin.includes('*') ? true : env.corsOrigin,
      credentials: true,
    },
    // Generous for mobile: a phone changing from wifi to cellular should
    // reconnect, not be treated as gone.
    pingTimeout: 30_000,
    pingInterval: 25_000,
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

    handleConnect(io, socket).catch((err) =>
      console.error('[socket] connect failed', err)
    );

    registerPresence(io, socket);
    registerChat(io, socket);
    registerCalls(io, socket);

    socket.on('disconnect', () => {
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

  // Unconditionally. A connected socket means the account is online, and that
  // is true of the second device as much as the first — `setPresence` is
  // idempotent, so a status that has not changed writes nothing and announces
  // nothing, which is what the count check here used to be for.
  //
  // It was `if (sockets.length === 1)`, and that is a different question from
  // the one being asked. A phone whose connection died silently leaves a
  // socket in the room until the server's ping times it out, so a reconnect
  // inside that window saw two sockets, skipped the update, and left the
  // account offline to everyone while the app sat there connected — with
  // nothing to recover it, because the next thing to touch presence was the
  // *disconnect* of the socket it had just replaced.
  await profileService.setPresence(userId, 'online');

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

  // A call that started while this user had no live socket never got its
  // `call:incoming` — the caller is still showing "Calling". This connection
  // *is* that ring landing, so treat it exactly like one: tell the caller it
  // is now really ringing (inside `markRingDelivered`), and tell this socket
  // it has an incoming call, the same as if it had arrived live.
  let justDelivered = false;
  if (
    activeCall &&
    activeCall.calleeId === userId &&
    activeCall.status === 'ringing' &&
    !activeCall.ringDeliveredAt
  ) {
    activeCall = await callService.markRingDelivered(activeCall.id);
    justDelivered = true;
  }

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
      if (justDelivered) socket.emit('call:incoming', media);
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
 * Marks the user offline once their last device goes.
 *
 * A live call is ended too. Leaving a call `connected` after the caller
 * vanished would bill them for silence — the billing ticker does not care that
 * nobody is listening.
 */
async function handleDisconnect(io, socket) {
  const userId = socket.userId;

  const sockets = await io.in(roomFor(userId)).fetchSockets();
  if (sockets.length > 0) return; // Another device is still on.

  const activeCall = await callService.getActive(userId);
  if (activeCall) {
    await callService
      .end({ id: userId }, activeCall.id, { reason: 'networkError', force: true })
      .catch(() => {});
  }

  await profileService.setPresence(userId, 'offline');
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
      });
      return { call: await callService.withMedia(call, socket.userId) };
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
