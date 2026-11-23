-- Disconnected calls: one row per live call that the other person ended on a
-- woman (he hung up, or his connection dropped). Kept apart from "calls"
-- because clearing call history deletes those rows, and this record has to
-- outlive that. Additive only — nothing existing is altered.

-- CreateTable
CREATE TABLE "call_disconnects" (
    "id" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "byUserId" TEXT NOT NULL,
    "type" "CallType" NOT NULL,
    "reason" "CallEndReason" NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_disconnects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "call_disconnects_callId_key" ON "call_disconnects"("callId");

-- CreateIndex
CREATE INDEX "call_disconnects_userId_createdAt_idx" ON "call_disconnects"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "call_disconnects_userId_byUserId_createdAt_idx" ON "call_disconnects"("userId", "byUserId", "createdAt");
