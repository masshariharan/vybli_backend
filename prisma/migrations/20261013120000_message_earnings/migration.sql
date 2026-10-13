-- Chat earnings: a woman who earns is paid her share of every paid message
-- sent to her, kept as one earning per conversation per day.
ALTER TABLE "earnings" ALTER COLUMN "callId" DROP NOT NULL;

ALTER TABLE "earnings"
  ADD COLUMN "conversationId" TEXT,
  ADD COLUMN "senderId" TEXT,
  ADD COLUMN "day" DATE,
  ADD COLUMN "messages" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "earnings_userId_conversationId_day_key"
  ON "earnings"("userId", "conversationId", "day");
