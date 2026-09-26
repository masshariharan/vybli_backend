'use strict';

const prisma = require('../config/prisma');
const relationship = require('./relationship.service');

/**
 * Favourites.
 *
 * A private bookmark, not a relationship the other person is ever told
 * about. One-directional like a block, but the opposite in effect: it grants
 * nothing and forbids nothing, it only changes what the favoriting account
 * sees first. Nothing here should ever notify the favorited user.
 */

/**
 * Marks `targetId` as a favourite of `user`.
 *
 * Idempotent — favoriting someone already favorited is not an error, since
 * the client's star toggle only knows two states and a double-tap racing
 * itself must not throw on the unique constraint.
 */
async function addFavorite(user, targetId) {
  await relationship.assertCanInteract(user.id, targetId);
  await prisma.favorite.upsert({
    where: {
      favoritedById_favoriteUserId: {
        favoritedById: user.id,
        favoriteUserId: targetId,
      },
    },
    create: { favoritedById: user.id, favoriteUserId: targetId },
    update: {},
  });
}

/** Also idempotent, for the same reason. */
async function removeFavorite(userId, targetId) {
  await prisma.favorite.deleteMany({
    where: { favoritedById: userId, favoriteUserId: targetId },
  });
}

async function isFavorite(userId, targetId) {
  const row = await prisma.favorite.findUnique({
    where: {
      favoritedById_favoriteUserId: {
        favoritedById: userId,
        favoriteUserId: targetId,
      },
    },
    select: { id: true },
  });
  return Boolean(row);
}

/**
 * Everyone `userId` has favorited, as a Set of ids.
 *
 * For bulk enrichment — the discovery feed marks a star on every row in one
 * query rather than one lookup per candidate.
 */
async function favoriteIdsFor(userId) {
  const rows = await prisma.favorite.findMany({
    where: { favoritedById: userId },
    select: { favoriteUserId: true },
  });
  return new Set(rows.map((r) => r.favoriteUserId));
}

/**
 * Everyone who has `userId` starred, as an array of ids.
 *
 * Read by `deleteAccount` before it removes those rows, so the people whose
 * Favourites tab is about to lose a card can be told in real time.
 */
async function favoritedByIdsFor(userId) {
  const rows = await prisma.favorite.findMany({
    where: { favoriteUserId: userId },
    select: { favoritedById: true },
  });
  return rows.map((r) => r.favoritedById);
}

/**
 * Everyone this account has favorited, most recently favorited first.
 *
 * Blocked people are excluded the same way discovery and the Chats screen
 * exclude them: a favourite you can no longer interact with is not something
 * the Favourites tab should still offer to call.
 *
 * So is any account that is no longer live. `deleteAccount` removes the rows
 * pointing at a deleted account, but the filter is what keeps that true for
 * rows written before it did, and for a suspended account — whose rows are
 * kept, so a restored account comes back to the lists it was on, but which
 * `loadCounterpart` refuses every interaction with in the meantime.
 */
async function listFavorites(userId, { skip, take }) {
  const blockedIds = await relationship.blockedIdsFor(userId);
  const where = {
    favoritedById: userId,
    favoriteUserId: { notIn: [...blockedIds] },
    favoriteUser: { status: 'active', deletedAt: null },
  };

  const [rows, total] = await Promise.all([
    prisma.favorite.findMany({
      where,
      include: {
        favoriteUser: {
          include: {
            profile: true,
            privacySettings: true,
            languages: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.favorite.count({ where }),
  ]);

  return { rows: rows.map((r) => r.favoriteUser), total };
}

module.exports = {
  addFavorite,
  removeFavorite,
  isFavorite,
  favoriteIdsFor,
  favoritedByIdsFor,
  listFavorites,
};
