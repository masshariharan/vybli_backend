-- Disappearing messages: a per-conversation timer (24 hours or 7 days) and
-- each message's own expiry, fixed from that timer when it was sent.
ALTER TABLE "conversations" ADD COLUMN "messageTtlHours" INTEGER NOT NULL DEFAULT 168;
ALTER TABLE "messages" ADD COLUMN "expiresAt" TIMESTAMP(3);
CREATE INDEX "messages_expiresAt_idx" ON "messages"("expiresAt");
