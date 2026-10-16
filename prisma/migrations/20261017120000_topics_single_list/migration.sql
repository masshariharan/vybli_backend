-- Topics are all public now: there is no longer a private option. The ones a
-- person had marked private are dropped rather than merged into the public
-- list, so nothing somebody chose to hide becomes visible. What is left is a
-- single list, renamed to say so.

-- AlterTable
ALTER TABLE "user_profiles" DROP COLUMN "privateTopics";
ALTER TABLE "user_profiles" RENAME COLUMN "publicTopics" TO "topics";
