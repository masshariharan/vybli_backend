-- DropIndex
DROP INDEX "wallet_transactions_providerOrderId_key";

-- DropIndex
DROP INDEX "wallet_transactions_providerPaymentId_key";

-- AlterTable
ALTER TABLE "wallet_transactions" DROP COLUMN "providerOrderId",
DROP COLUMN "providerPaymentId",
ADD COLUMN     "purchaseToken" TEXT;

-- DropTable
DROP TABLE "payment_webhook_events";

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transactions_purchaseToken_key" ON "wallet_transactions"("purchaseToken");

