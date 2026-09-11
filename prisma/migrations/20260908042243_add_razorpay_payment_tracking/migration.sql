-- AlterTable
ALTER TABLE "wallet_transactions" ADD COLUMN     "providerOrderId" TEXT,
ADD COLUMN     "providerPaymentId" TEXT;

-- CreateTable
CREATE TABLE "payment_webhook_events" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_webhook_events_eventId_key" ON "payment_webhook_events"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transactions_providerOrderId_key" ON "wallet_transactions"("providerOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transactions_providerPaymentId_key" ON "wallet_transactions"("providerPaymentId");

