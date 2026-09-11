-- AlterTable
-- Reverts the previous migration's default: `voice` is the only kind
-- anything submits again. `video` stays in the enum (unused, zero rows) —
-- Postgres cannot drop a single enum value without recreating the type.
ALTER TABLE "verifications" ALTER COLUMN "kind" SET DEFAULT 'voice';
