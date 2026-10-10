-- Men get levels too. The ladder gains an audience — `female` (every
-- existing row: the ladder women have been priced by) or `male` (new: prices
-- calls to a man from other men; Vybli keeps all of it) — and each call
-- records whose ladder priced it.

-- Existing ladder rows are the women's.
ALTER TABLE "call_levels" ADD COLUMN "audience" TEXT NOT NULL DEFAULT 'female';
ALTER TABLE "call_levels" ALTER COLUMN "audience" DROP DEFAULT;
ALTER TABLE "call_levels" DROP CONSTRAINT "call_levels_pkey",
ADD CONSTRAINT "call_levels_pkey" PRIMARY KEY ("audience", "type", "level");

-- The men's ladder starts from the launch values; it is edited separately.
-- minSeconds is the spec's hours × 3600.
INSERT INTO "call_levels" ("audience", "type", "level", "name", "minSeconds", "minUniqueCallers", "ratePerMinute", "updatedAt") VALUES
  ('male', 'voice', 1, 'Starter',  0,      0,   3.00, CURRENT_TIMESTAMP),
  ('male', 'voice', 2, 'Silver',   10800,  5,   4.00, CURRENT_TIMESTAMP),
  ('male', 'voice', 3, 'Gold',     36000,  15,  5.00, CURRENT_TIMESTAMP),
  ('male', 'voice', 4, 'Platinum', 90000,  30,  6.00, CURRENT_TIMESTAMP),
  ('male', 'voice', 5, 'Diamond',  180000, 60,  7.00, CURRENT_TIMESTAMP),
  ('male', 'voice', 6, 'Elite',    360000, 100, 8.00, CURRENT_TIMESTAMP),
  ('male', 'video', 1, 'Starter',  0,      0,   7.00, CURRENT_TIMESTAMP),
  ('male', 'video', 2, 'Silver',   7200,   3,   9.00, CURRENT_TIMESTAMP),
  ('male', 'video', 3, 'Gold',     21600,  10,  12.00, CURRENT_TIMESTAMP),
  ('male', 'video', 4, 'Platinum', 54000,  20,  15.00, CURRENT_TIMESTAMP),
  ('male', 'video', 5, 'Diamond',  108000, 40,  18.00, CURRENT_TIMESTAMP),
  ('male', 'video', 6, 'Elite',    216000, 75,  20.00, CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;

-- Whose ladder priced each call. Every call priced by a level so far was
-- priced by a woman's.
ALTER TABLE "calls" ADD COLUMN "levelAudience" TEXT;
UPDATE "calls" SET "levelAudience" = 'female' WHERE "earnerLevel" IS NOT NULL;

-- Each level change keeps the ladder it was on; every change so far was a
-- woman's.
ALTER TABLE "earner_level_changes" ADD COLUMN "audience" TEXT NOT NULL DEFAULT 'female';

DROP INDEX "calls_type_earnerLevel_endedAt_idx";
CREATE INDEX "calls_levelAudience_type_earnerLevel_endedAt_idx" ON "calls"("levelAudience", "type", "earnerLevel", "endedAt");
