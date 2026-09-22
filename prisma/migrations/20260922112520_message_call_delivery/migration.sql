-- AlterTable
ALTER TABLE "calls" ADD COLUMN     "ringDeliveredAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "deliveredAt" TIMESTAMP(3);
