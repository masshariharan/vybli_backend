-- AlterTable
ALTER TABLE "users" ADD COLUMN     "firebaseUid" TEXT;

-- CreateIndex
CREATE INDEX "users_firebaseUid_idx" ON "users"("firebaseUid");
