-- AlterEnum
BEGIN;
CREATE TYPE "CallEndReason_new" AS ENUM ('hungUp', 'insufficientBalance', 'rejected', 'cancelled', 'missed', 'networkError');
ALTER TABLE "calls" ALTER COLUMN "endReason" TYPE "CallEndReason_new" USING (
  CASE "endReason"::text
    WHEN 'insufficientCoins' THEN 'insufficientBalance'
    ELSE "endReason"::text
  END
)::"CallEndReason_new";
ALTER TYPE "CallEndReason" RENAME TO "CallEndReason_old";
ALTER TYPE "CallEndReason_new" RENAME TO "CallEndReason";
DROP TYPE "CallEndReason_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "TransactionKind_new" AS ENUM ('purchase', 'call', 'earning', 'withdrawal', 'bonus');
ALTER TABLE "wallet_transactions" ALTER COLUMN "kind" TYPE "TransactionKind_new" USING (
  CASE "kind"::text
    WHEN 'coinPurchase' THEN 'purchase'
    ELSE "kind"::text
  END
)::"TransactionKind_new";
ALTER TYPE "TransactionKind" RENAME TO "TransactionKind_old";
ALTER TYPE "TransactionKind_new" RENAME TO "TransactionKind";
DROP TYPE "TransactionKind_old";
COMMIT;

-- AlterTable
ALTER TABLE "calls" DROP COLUMN "coinsSpent",
ADD COLUMN     "amountSpent" DECIMAL(12,2) NOT NULL DEFAULT 0,
ALTER COLUMN "ratePerMinute" SET DEFAULT 0,
ALTER COLUMN "ratePerMinute" SET DATA TYPE DECIMAL(10,2);

-- AlterTable
ALTER TABLE "user_profiles" DROP COLUMN "videoCoinsPerMinute",
DROP COLUMN "voiceCoinsPerMinute",
ADD COLUMN     "videoRatePerMinute" DECIMAL(10,2) NOT NULL DEFAULT 20,
ADD COLUMN     "voiceRatePerMinute" DECIMAL(10,2) NOT NULL DEFAULT 12;

-- AlterTable
ALTER TABLE "verifications" ALTER COLUMN "kind" SET DEFAULT 'video';

-- AlterTable
ALTER TABLE "vip_plans" DROP COLUMN "bonusCoins",
ADD COLUMN     "bonusInr" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "wallet_transactions" DROP COLUMN "coinDelta";

-- AlterTable
ALTER TABLE "wallets" DROP COLUMN "coins",
ADD COLUMN     "balance" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- DropTable
DROP TABLE "coin_packages";

-- CreateTable
CREATE TABLE "recharge_packages" (
    "id" TEXT NOT NULL,
    "priceInr" DECIMAL(10,2) NOT NULL,
    "bonusInr" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "isPopular" BOOLEAN NOT NULL DEFAULT false,
    "isBestValue" BOOLEAN NOT NULL DEFAULT false,
    "tagline" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "recharge_packages_pkey" PRIMARY KEY ("id")
);

