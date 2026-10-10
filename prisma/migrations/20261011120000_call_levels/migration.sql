-- Level-based call pricing for women: a six-level ladder per call type, each
-- woman's voice and video levels, the counters they are earned from, the
-- unique-caller ledger, level history, and the earner's share as a setting.
-- Everyone starts at Starter; past calls are not counted (statsCountedAt is
-- null on them, and only calls ending after this ships are ever counted).

-- AlterTable
ALTER TABLE "user_profiles" ADD COLUMN     "videoLevel" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "voiceLevel" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "calls" ADD COLUMN     "earnerLevel" INTEGER,
ADD COLUMN     "earnerShare" DECIMAL(5,4),
ADD COLUMN     "statsCountedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "call_levels" (
    "type" "CallType" NOT NULL,
    "level" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "minSeconds" INTEGER NOT NULL,
    "minUniqueCallers" INTEGER NOT NULL,
    "ratePerMinute" DECIMAL(10,2) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "call_levels_pkey" PRIMARY KEY ("type","level")
);

-- CreateTable
CREATE TABLE "pricing_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "earnerShare" DECIMAL(5,4) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pricing_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "earner_call_stats" (
    "userId" TEXT NOT NULL,
    "type" "CallType" NOT NULL,
    "billableSeconds" INTEGER NOT NULL DEFAULT 0,
    "uniqueCallers" INTEGER NOT NULL DEFAULT 0,
    "countedCalls" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "earner_call_stats_pkey" PRIMARY KEY ("userId","type")
);

-- CreateTable
CREATE TABLE "earner_callers" (
    "earnerId" TEXT NOT NULL,
    "callerId" TEXT NOT NULL,
    "type" "CallType" NOT NULL,
    "firstCallId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "earner_callers_pkey" PRIMARY KEY ("earnerId","callerId","type")
);

-- CreateTable
CREATE TABLE "earner_level_changes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "CallType" NOT NULL,
    "fromLevel" INTEGER NOT NULL,
    "toLevel" INTEGER NOT NULL,
    "fromName" TEXT NOT NULL,
    "toName" TEXT NOT NULL,
    "fromRate" DECIMAL(10,2) NOT NULL,
    "toRate" DECIMAL(10,2) NOT NULL,
    "source" TEXT NOT NULL,
    "reason" TEXT,
    "actor" TEXT,
    "callId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "earner_level_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "earner_level_changes_userId_createdAt_idx" ON "earner_level_changes"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "earner_level_changes_createdAt_idx" ON "earner_level_changes"("createdAt");

-- CreateIndex
CREATE INDEX "user_profiles_voiceLevel_idx" ON "user_profiles"("voiceLevel");

-- CreateIndex
CREATE INDEX "user_profiles_videoLevel_idx" ON "user_profiles"("videoLevel");

-- CreateIndex
CREATE INDEX "calls_type_earnerLevel_endedAt_idx" ON "calls"("type", "earnerLevel", "endedAt");

-- AddForeignKey
ALTER TABLE "earner_call_stats" ADD CONSTRAINT "earner_call_stats_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "earner_level_changes" ADD CONSTRAINT "earner_level_changes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Seed: the launch ladder. minSeconds is the spec's hours × 3600.
INSERT INTO "call_levels" ("type", "level", "name", "minSeconds", "minUniqueCallers", "ratePerMinute", "updatedAt") VALUES
  ('voice', 1, 'Starter',  0,      0,   3.00, CURRENT_TIMESTAMP),
  ('voice', 2, 'Silver',   10800,  5,   4.00, CURRENT_TIMESTAMP),
  ('voice', 3, 'Gold',     36000,  15,  5.00, CURRENT_TIMESTAMP),
  ('voice', 4, 'Platinum', 90000,  30,  6.00, CURRENT_TIMESTAMP),
  ('voice', 5, 'Diamond',  180000, 60,  7.00, CURRENT_TIMESTAMP),
  ('voice', 6, 'Elite',    360000, 100, 8.00, CURRENT_TIMESTAMP),
  ('video', 1, 'Starter',  0,      0,   7.00, CURRENT_TIMESTAMP),
  ('video', 2, 'Silver',   7200,   3,   9.00, CURRENT_TIMESTAMP),
  ('video', 3, 'Gold',     21600,  10,  12.00, CURRENT_TIMESTAMP),
  ('video', 4, 'Platinum', 54000,  20,  15.00, CURRENT_TIMESTAMP),
  ('video', 5, 'Diamond',  108000, 40,  18.00, CURRENT_TIMESTAMP),
  ('video', 6, 'Elite',    216000, 75,  20.00, CURRENT_TIMESTAMP);

-- The earner's share: 30% to her, 70% to Vybli.
INSERT INTO "pricing_settings" ("id", "earnerShare", "updatedAt") VALUES (1, 0.3000, CURRENT_TIMESTAMP);
