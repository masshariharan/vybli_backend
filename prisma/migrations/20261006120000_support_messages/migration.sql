-- Help & Support: messages sent from the app's support screen, read and
-- resolved in the admin panel's Support inbox.

-- CreateEnum
CREATE TYPE "SupportCategory" AS ENUM ('question', 'bug');

-- CreateEnum
CREATE TYPE "SupportStatus" AS ENUM ('open', 'resolved');

-- AlterEnum
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'support_message';

-- CreateTable
CREATE TABLE "support_messages" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" "SupportCategory" NOT NULL,
    "message" TEXT NOT NULL,
    "status" "SupportStatus" NOT NULL DEFAULT 'open',
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "adminNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "support_messages_status_createdAt_idx" ON "support_messages"("status", "createdAt");

-- CreateIndex
CREATE INDEX "support_messages_userId_idx" ON "support_messages"("userId");

-- AddForeignKey
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

