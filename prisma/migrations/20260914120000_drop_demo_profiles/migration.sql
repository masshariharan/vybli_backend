-- Removes the seeded-demo-profile flag.
--
-- `seed-demo.js` wrote 22 fixture accounts marked `isDemo` so a developer had
-- somebody to call, and two queries carried a predicate to keep them out of
-- real users' sight: the discovery feed, and the per-city member counts. That
-- second one went unnoticed for a while, which is the shape of the problem — a
-- category of row that has to be hidden everywhere is a predicate every future
-- query must remember, and one of them will not.
--
-- The seeder is gone, so the category goes with it. Every profile in this
-- table now belongs to somebody who signed up.
--
-- Any rows the seeder left behind are removed rather than adopted. There is no
-- real phone number behind one, so keeping them would put unreachable accounts
-- into discovery the moment the predicate protecting them disappeared — the
-- opposite of what dropping this is for.
--
-- Deleted through `users`, not `user_profiles`: every relation to a user
-- cascades, so removing the account takes its profile, conversations, calls
-- and wallet with it. Deleting the profile alone would strand the account row
-- it belongs to.
--
-- A no-op on any database the seeder never ran against, production included.
DELETE FROM "users"
WHERE "id" IN (SELECT "userId" FROM "user_profiles" WHERE "isDemo" = true);

DROP INDEX IF EXISTS "user_profiles_isDemo_idx";

ALTER TABLE "user_profiles" DROP COLUMN "isDemo";
