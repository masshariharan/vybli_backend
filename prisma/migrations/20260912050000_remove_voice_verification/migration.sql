-- Removes voice identification entirely: the per-attempt `verifications`
-- table (recordings, language, duration, review history) and its two enums.
-- Verification is now manual and lives directly on `user_profiles` — a
-- status plus who decided it and when, set by an administrator with nothing
-- for a client to submit.
--
-- The old `VerificationStatus` enum is dropped and recreated rather than
-- narrowed with the usual create-new-type/swap dance: the only column that
-- ever used it is the `verifications` table being dropped in this same
-- migration, so by the time the new `user_profiles` column needs the type
-- nothing old is left using it.

-- DropForeignKey
ALTER TABLE "verifications" DROP CONSTRAINT "verifications_userId_fkey";

-- DropTable
DROP TABLE "verifications";

-- DropEnum
DROP TYPE "VerificationKind";
DROP TYPE "VerificationStatus";

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('not_required', 'pending', 'verified', 'rejected');

-- AlterTable
ALTER TABLE "user_profiles"
  ADD COLUMN "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'not_required',
  ADD COLUMN "verificationRequestedAt" TIMESTAMP(3),
  ADD COLUMN "verifiedAt" TIMESTAMP(3),
  ADD COLUMN "verifiedBy" TEXT,
  ADD COLUMN "rejectionReason" TEXT;
