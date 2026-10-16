-- "What's on your mind?" topics on the profile: the ones other users may see,
-- and the ones kept to the owner. Empty for every existing account until they
-- pick some.

-- AlterTable
ALTER TABLE "user_profiles" ADD COLUMN "publicTopics" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "privateTopics" TEXT[] DEFAULT ARRAY[]::TEXT[];
