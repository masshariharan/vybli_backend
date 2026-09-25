-- "Delete chat" is per side, like pinning: each person's own copy of the
-- thread is cleared from this moment back, and the other person's is untouched.
-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "deletedAtByA" TIMESTAMP(3),
ADD COLUMN     "deletedAtByB" TIMESTAMP(3);
