-- Exactly-once message delivery.
--
-- A send that times out tells the client nothing about whether it landed: the
-- request may have died on the way out, or on the way back with the row
-- already written. Retrying is the only thing the client can do about that,
-- and until now a retry wrote a second copy — so a flaky connection turned one
-- message into two on the recipient's screen, permanently, with no way to tell
-- the duplicate from a message somebody genuinely sent twice.
--
-- The sender now stamps each message with an id generated on the device, and
-- the send is keyed on it: a retry carrying the same id finds the first
-- attempt and returns it instead of inserting again.
--
-- Nullable, and no backfill. It only exists going forward — every message
-- already sent has no client id and needs none, and Postgres treats NULLs as
-- distinct in a unique index, so any number of them coexist happily.

-- AlterTable
ALTER TABLE "messages" ADD COLUMN "clientId" TEXT;

-- Scoped to the sender rather than global: the id is generated on a device, so
-- two accounts can pick the same one and neither should shadow the other.
-- CreateIndex
CREATE UNIQUE INDEX "messages_senderId_clientId_key" ON "messages"("senderId", "clientId");
