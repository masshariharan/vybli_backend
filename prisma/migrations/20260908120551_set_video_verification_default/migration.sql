-- AlterTable
-- Split from the enum addition above — Postgres requires the new value to be
-- committed in its own transaction before anything can default to it.
ALTER TABLE "verifications" ALTER COLUMN "kind" SET DEFAULT 'video';
