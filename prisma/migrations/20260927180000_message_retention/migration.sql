-- Messages are deleted once they are older than the retention window (7 days
-- by default, see `services/retention.service`); the purge selects by age
-- across every conversation, which the existing (conversationId, createdAt)
-- index cannot serve.
CREATE INDEX IF NOT EXISTS "messages_createdAt_idx" ON "messages"("createdAt");
