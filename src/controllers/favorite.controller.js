'use strict';

const favoriteService = require('../services/favorite.service');
const serialize = require('../utils/serialize');
const { ok, paginated } = require('../utils/respond');
const { q } = require('../middleware/validate');
const { toSkipTake } = require('../validators/common');

async function add(req, res) {
  await favoriteService.addFavorite(req.user, req.params.id);
  return ok(res, { favorited: true }, 'Added to favourites');
}

async function remove(req, res) {
  await favoriteService.removeFavorite(req.userId, req.params.id);
  return ok(res, { favorited: false }, 'Removed from favourites');
}

/** Every row here is, by definition, a favourite of the caller's. */
async function list(req, res) {
  const params = q(req);
  const { skip, take } = toSkipTake(params);

  const { rows, total } = await favoriteService.listFavorites(req.userId, {
    skip,
    take,
  });
  const body = rows.map((u) =>
    serialize.publicUser(u, {
      viewer: req.userId,
      viewerProfile: req.user.profile,
      viewerPrivacy: req.user.privacySettings,
      favorited: true,
    })
  );

  return paginated(res, body, { page: params.page, limit: params.limit, total });
}

/** Every favourite's id — see `favoriteService.listFavoriteIds`. */
async function ids(req, res) {
  const userIds = await favoriteService.listFavoriteIds(req.userId);
  return ok(res, { user_ids: userIds }, 'Favourite ids');
}

module.exports = { add, remove, list, ids };
