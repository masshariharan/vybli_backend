'use strict';

/**
 * Pairing — which two accounts this app connects at all: see, chat with, call.
 *
 * Asked here and nowhere else. Discovery builds its query from
 * [pairableWhere], every chat and call guard in `relationship.service` asks
 * [canPair], and the serializer sends the client the same answer per person
 * (`can_interact`), so a rule changed here is changed everywhere at once
 * rather than on three paths out of four.
 *
 * Pure functions over already-loaded rows — no database access — which is
 * what lets the serializer use them too.
 */

// An account's *side* is its role: Earn Money or Make Friends. Onboarding
// derives it from gender (female → earner), so "same side" is "same gender".
//
//  * Opposite sides always pair. This is the product, and nothing about it
//    depends on the setting below — turning "Show All Users" on or off can
//    never cost anybody an opposite-gender match, chat or call.
//  * Same side pairs only when **both** accounts have "Show All Users" on.
//    Mutual rather than one-sided: somebody who left it off has said they
//    want to see and hear from the other side only, and a same-side account
//    that turned it on must not be able to reach them anyway.
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
 * May these two see and reach each other at all?
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
 * [canPair] as a Prisma `where` fragment over candidate users, for a listing
 * that has to filter in the query (so the count and the paging agree with
 * what is shown) rather than afterwards.
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

module.exports = { isSameSide, showsAllUsers, canPair, pairableWhere };
