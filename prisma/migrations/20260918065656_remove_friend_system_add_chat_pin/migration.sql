-- DropForeignKey
ALTER TABLE "friend_requests" DROP CONSTRAINT "friend_requests_addresseeId_fkey";

-- DropForeignKey
ALTER TABLE "friend_requests" DROP CONSTRAINT "friend_requests_requesterId_fkey";

-- DropForeignKey
ALTER TABLE "friendships" DROP CONSTRAINT "friendships_userAId_fkey";

-- DropForeignKey
ALTER TABLE "friendships" DROP CONSTRAINT "friendships_userBId_fkey";

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "pinnedByA" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pinnedByB" BOOLEAN NOT NULL DEFAULT false;

-- DropTable
DROP TABLE "friend_requests";

-- DropTable
DROP TABLE "friendships";

-- DropEnum
DROP TYPE "FriendRequestStatus";

