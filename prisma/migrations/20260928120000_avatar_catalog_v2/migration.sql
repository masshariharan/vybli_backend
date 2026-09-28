-- The avatar catalog was replaced with a new set of images. Ids are still the
-- filename without its extension and the zero-padded names were kept, so
-- every id that exists in both sets (male_01–male_17, female_01–female_03)
-- keeps resolving — to the new art.
--
-- The new set has no male_18–male_20, so an account still pointing at one of
-- those would serialize with a null avatar_url while onboarding still counts
-- it as having a photo. Move those accounts onto their gender's default
-- instead, the same fallback the original catalog migration used.
UPDATE "user_profiles"
  SET "avatarId" = CASE "gender" WHEN 'male' THEN 'male_01' ELSE 'female_01' END
  WHERE "avatarId" IS NOT NULL
    AND "avatarId" NOT IN (
      'male_01','male_02','male_03','male_04','male_05','male_06','male_07',
      'male_08','male_09','male_10','male_11','male_12','male_13','male_14',
      'male_15','male_16','male_17',
      'female_01','female_02','female_03','female_04','female_05','female_06',
      'female_07','female_08','female_09','female_10','female_11','female_12',
      'female_13','female_14','female_15'
    );
