-- A note the server writes into a conversation (e.g. the disappearing-
-- messages timer changed), drawn as a centred line rather than a bubble.
ALTER TABLE "messages" ADD COLUMN "event" TEXT;
ALTER TABLE "messages" ADD COLUMN "eventData" JSONB;
