-- Replaces per-user uploaded avatars with a predefined catalog. Nobody
-- uploads a file any more — `avatarId` names one of the server's own
-- bundled images (see `src/config/avatarCatalog.js`), so every account
-- pointing at the same face costs one file, not one per account.
--
-- The old `avatarUrl` values are meaningless afterwards: every one of them
-- pointed at a per-user uploaded file that is being deleted from disk in
-- this same change, so there is nothing worth preserving by renaming the
-- column instead of dropping it.

-- AlterTable
ALTER TABLE "user_profiles" DROP COLUMN "avatarUrl",
ADD COLUMN     "avatarId" TEXT;

-- Every account gets a real, valid catalog avatar rather than starting
-- null — the same thing onboarding's own photo step already does the
-- moment it opens, applied once here so an existing account (including one
-- whose uploaded photo just disappeared) never renders with nothing.
UPDATE "user_profiles"
  SET "avatarId" = CASE "gender" WHEN 'male' THEN 'male_01' ELSE 'female_01' END;
