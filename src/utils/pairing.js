'use strict';

/**
 * Pairing — which two accounts this app connects at all: see, chat with, call.
 *
 * Asked here and nowhere else. The Home feed builds its query from
 * [visibleSideWhere] and random match from [pairableWhere], every chat and
 * call guard in `relationship.service` asks [canPair], and the serializer
 * sends the client that same answer per person (`can_interact`), so a rule
 * changed here is changed everywhere at once rather than on three paths out
 * of four.
 *
 * Pure functions over already-loaded rows — no database access — which is
 * what lets the serializer use them too.
 */

// An account's *side* is its role: Earn Money or Make Friends. Onboarding
// derives it from gender (female → earner), so "same side" is "same gender".
//
// Two questions, deliberately answered differently:
//
//  * **Who appears in my feed** — [canSee], [visibleSideWhere]. Only the
//    viewer's own switch: with "Show All Users" on, the Home feed holds both
//    men and women, whatever each of them chose. Seeing someone reaches
//    nobody.
//  * **Who I may chat with and call** — [canPair], [pairableWhere]. The other
//    side always; the same side only when **both** have "Show All Users" on.
//    Somebody who left it off has said they want to hear from the other
//    side only, and appearing in a same-gender feed must not change that —
//    their card shows, with Chat and Call unavailable.
//
// Opposite sides always see and pair. Nothing about "Show All Users" can ever
// cost anybody an opposite-gender match, chat or call.
//
// Same-side calls are free — see `call.service.startUnlocked`. Billing only
// ever runs between an earner and a non-earner, which is exactly the pairing
// it always ran between.

/** Both earners, or both not — the pairing billing has no payer/earner for. */
function isSameSide(user, other) {
  return Boolean(user?.profile?.isEarner) === Boolean(other?.profile?.isEarner);
}

/** This account's "Show All Users" switch. Off unless explicitly on. */
function showsAllUsers(user) {
  return user?.privacySettings?.showAllUsers === true;
}

/**
 * Does `other` belong in `viewer`'s feed? The viewer's own switch alone.
 */
function canSee(viewer, other) {
  return !isSameSide(viewer, other) || showsAllUsers(viewer);
}

/**
 * May these two chat with and call each other?
 *
 * Needs both users' `profile` and `privacySettings` loaded — which every
 * guard here already has (`req.user` and [loadCounterpart] both include
 * them).
 */
function canPair(user, other) {
  if (!isSameSide(user, other)) return true;
  return showsAllUsers(user) && showsAllUsers(other);
}

/**
 * [canSee] as a Prisma `where` fragment over candidate users — the Home feed.
 *
 * Meant to go under an `AND`, like [pairableWhere], and for the same reason.
 * With the switch on there is no side condition at all: everybody.
 */
function visibleSideWhere(viewer) {
  if (showsAllUsers(viewer)) return {};
  return { profile: { isEarner: !viewer?.profile?.isEarner } };
}

/**
 * [canPair] as a Prisma `where` fragment over candidate users, for a listing
 * whose result is somebody to call — random match, which rings at once.
 * Filtered in the query so the count and the paging agree with what is
 * shown.
 *
 * Meant to go under an `AND`, so a caller replacing `profile` or
 * `privacySettings` wholesale with its own conditions cannot drop it.
 */
function pairableWhere(viewer) {
  const viewerIsEarner = Boolean(viewer?.profile?.isEarner);
  const oppositeSide = { profile: { isEarner: !viewerIsEarner } };
  if (!showsAllUsers(viewer)) return oppositeSide;
  return {
    OR: [
      oppositeSide,
      {
        profile: { isEarner: viewerIsEarner },
        privacySettings: { showAllUsers: true },
      },
    ],
  };
}

module.exports = {
  isSameSide,
  showsAllUsers,
  canSee,
  canPair,
  visibleSideWhere,
  pairableWhere,
};
