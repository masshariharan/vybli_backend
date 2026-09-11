'use strict';

const friendService = require('../services/friend.service');
const relationshipService = require('../services/relationship.service');
const serialize = require('../utils/serialize');
const { ok, created, paginated } = require('../utils/respond');
const { q } = require('../middleware/validate');
const { toSkipTake } = require('../validators/common');

async function send(req, res) {
  const result = await friendService.send(req.user, {
    userId: req.body.user_id,
    message: req.body.message,
  });

  // Sending to someone whose request was already in your inbox accepts it
  // instead — the reply says so, because the client shows "Friend request
  // sent" otherwise and the truth is better news.
  if (result.viaReciprocal) {
    return ok(
      res,
      {
        request: serialize.friendRequest(result.request, req.userId),
        conversation_id: result.conversation?.id ?? null,
        connection_status: 'friends',
        auto_accepted: true,
      },
      'You are now friends — they had already sent you a request'
    );
  }

  return created(
    res,
    {
      request: serialize.friendRequest(result.request, req.userId),
      connection_status: 'requestSent',
    },
    'Friend request sent'
  );
}

async function accept(req, res) {
  const result = await friendService.accept(req.user, req.params.id);
  return ok(
    res,
    {
      request: serialize.friendRequest(result.request, req.userId),
      conversation_id: result.conversation?.id ?? null,
      connection_status: 'friends',
    },
    'You can now message each other'
  );
}

async function reject(req, res) {
  const request = await friendService.reject(req.user, req.params.id);
  return ok(
    res,
    {
      request: serialize.friendRequest(request, req.userId),
      connection_status: 'none',
    },
    'Request declined'
  );
}

async function cancel(req, res) {
  const request = await friendService.cancel(req.user, req.params.id);
  return ok(
    res,
    {
      request: serialize.friendRequest(request, req.userId),
      connection_status: 'none',
    },
    'Request cancelled'
  );
}

async function unfriend(req, res) {
  const result = await friendService.unfriend(req.user, req.params.id);
  return ok(res, { ...result, connection_status: 'none' }, 'Removed');
}

async function listRequests(req, res) {
  const params = q(req);
  const { skip, take } = toSkipTake(params);
  const { rows, total } = await friendService.listRequests(req.user, {
    direction: params.direction,
    status: params.status,
    skip,
    take,
  });
  return paginated(
    res,
    rows.map((r) => serialize.friendRequest(r, req.userId)),
    { page: params.page, limit: params.limit, total }
  );
}

async function listFriends(req, res) {
  const params = q(req);
  const { skip, take } = toSkipTake(params);
  const { rows, total } = await friendService.listFriends(req.user, { skip, take });
  return paginated(
    res,
    rows.map((u) =>
      serialize.publicUser(u, { viewer: req.userId, viewerProfile: req.user.profile })
    ),
    { page: params.page, limit: params.limit, total }
  );
}

/** Where the two of us stand — drives the profile's primary button. */
async function status(req, res) {
  const connectionStatus = await relationshipService.connectionStatus(
    req.userId,
    req.params.id
  );
  return ok(res, { connection_status: connectionStatus }, 'Connection status');
}

module.exports = {
  send,
  accept,
  reject,
  cancel,
  unfriend,
  listRequests,
  listFriends,
  status,
};
