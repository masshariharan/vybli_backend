-- Withdrawals: each request to pay an earner out to her UPI ID, and what
-- happened to it; plus the RazorpayX contact and fund account on her wallet.
-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('requested', 'processing', 'paid', 'failed', 'reversed');

-- AlterTable
ALTER TABLE "wallets" ADD COLUMN     "payoutContactId" TEXT,
ADD COLUMN     "payoutFundAccountFor" TEXT,
ADD COLUMN     "payoutFundAccountId" TEXT;

-- CreateTable
CREATE TABLE "withdrawals" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'requested',
    "upiMasked" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerPayoutId" TEXT,
    "utr" TEXT,
    "failureReason" TEXT,
    "transactionId" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "withdrawals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "withdrawals_providerPayoutId_key" ON "withdrawals"("providerPayoutId");

-- CreateIndex
CREATE UNIQUE INDEX "withdrawals_transactionId_key" ON "withdrawals"("transactionId");

-- CreateIndex
CREATE INDEX "withdrawals_userId_createdAt_idx" ON "withdrawals"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "withdrawals_status_createdAt_idx" ON "withdrawals"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

