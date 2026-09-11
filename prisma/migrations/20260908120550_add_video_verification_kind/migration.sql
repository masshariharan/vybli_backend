-- AlterEnum
-- Split into its own migration: Postgres refuses to use a new enum value in
-- the same transaction that adds it ("New enum values must be committed
-- before they can be used") — the DEFAULT change that uses 'video' has to
-- wait for the next migration.
ALTER TYPE "VerificationKind" ADD VALUE 'video';
