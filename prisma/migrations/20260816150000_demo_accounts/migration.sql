-- Marks a seeded demo profile.
--
-- On a real backend nobody is on the other end of a seeded account, so a
-- friend request to one would hang for ever and a call would ring out — the
-- half of the product that matters could never be reached on one device. When
-- DEMO_AUTO_RESPOND is on, these accounts answer: they accept requests, pick
-- up calls and reply to messages, the same affordance the Flutter app used to
-- fake locally.
--
-- Off in production, where the flag is false and this column is inert.
ALTER TABLE "user_profiles" ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "user_profiles_isDemo_idx" ON "user_profiles" ("isDemo");
