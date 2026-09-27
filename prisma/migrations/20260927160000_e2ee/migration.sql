-- End-to-end encryption: the device key directory, the encrypted envelope on
-- each message, and the evidence a reporter can attach (the only readable copy
-- of an encrypted chat a moderator ever gets).

CREATE TABLE "e2ee_devices" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'android',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "e2ee_devices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "e2ee_devices_userId_deviceId_key" ON "e2ee_devices"("userId", "deviceId");
CREATE INDEX "e2ee_devices_userId_revokedAt_idx" ON "e2ee_devices"("userId", "revokedAt");

ALTER TABLE "e2ee_devices" ADD CONSTRAINT "e2ee_devices_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "messages" ADD COLUMN "envelope" JSONB;

ALTER TABLE "reports" ADD COLUMN "evidence" JSONB;
