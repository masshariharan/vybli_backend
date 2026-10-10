-- The last live location the app reported, for the admin panel. Nullable
-- throughout: nothing is known until the app next opens with a live fix.

-- AlterTable
ALTER TABLE "user_profiles" ADD COLUMN "locationLat" DOUBLE PRECISION,
ADD COLUMN "locationLng" DOUBLE PRECISION,
ADD COLUMN "locationAccuracy" DOUBLE PRECISION,
ADD COLUMN "locationArea" TEXT,
ADD COLUMN "locationDistrict" TEXT,
ADD COLUMN "locationState" TEXT,
ADD COLUMN "locatedAt" TIMESTAMP(3);
