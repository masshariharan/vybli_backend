/*
  Warnings:

  - You are about to drop the column `bankAccountHolder` on the `wallets` table. All the data in the column will be lost.
  - You are about to drop the column `bankAccountNumber` on the `wallets` table. All the data in the column will be lost.
  - You are about to drop the column `bankIfsc` on the `wallets` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "wallets" DROP COLUMN "bankAccountHolder",
DROP COLUMN "bankAccountNumber",
DROP COLUMN "bankIfsc",
ADD COLUMN     "payoutUpiId" TEXT;
