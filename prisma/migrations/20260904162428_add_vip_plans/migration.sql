-- AlterTable
ALTER TABLE "wallets" ADD COLUMN     "vipExpiresAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "vip_plans" (
    "id" TEXT NOT NULL,
    "days" INTEGER NOT NULL,
    "priceInr" DECIMAL(10,2) NOT NULL,
    "bonusCoins" INTEGER NOT NULL DEFAULT 0,
    "isBest" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "vip_plans_pkey" PRIMARY KEY ("id")
);
