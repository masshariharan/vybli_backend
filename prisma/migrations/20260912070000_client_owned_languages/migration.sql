-- The language catalogue moves into the client.
--
-- `languages` was a seeded reference table the mobile app fetched over
-- `GET /languages` before it could draw its onboarding language step, and that
-- the `user_languages` rows pointed at by foreign key. It was the wrong owner
-- for the data twice over.
--
-- It is static: sixty-seven codes, names and scripts that change about as often
-- as the Eighth Schedule does. Paying a round trip for it on the highest-dropoff
-- step in sign-up bought nothing, and it failed in the worst available way — an
-- unseeded database answered `200` with an empty list, which the app rendered as
-- a blank screen under a button that never enabled. The foreign key then made
-- that unrecoverable rather than merely ugly: even a client that knew the codes
-- could not save them, because no row existed to reference.
--
-- Afterwards the code is the identity end to end. The client holds the
-- catalogue, sends codes, and resolves names itself; the server stores the codes
-- it is given and matches on them. Nothing maps between names and codes at a
-- boundary any more, which is what used to drop a language silently whenever the
-- two copies of the list disagreed about a spelling.

-- Discovery filters stored display names, because that is what they matched on
-- (`language: { name: { in: [...] } }`). They match on codes now, so the saved
-- ones are translated rather than dropped — a filter left pointing at a name
-- would match nobody, and an empty feed does not say why it is empty.
--
-- Matched exactly rather than case-insensitively on purpose: every stored value
-- was written from the app's own catalogue, so it carries that catalogue's
-- spelling verbatim. Anything that does not match came from somewhere else and
-- is not a language this server can name.
UPDATE "discovery_settings" ds
SET "languages" = COALESCE(
  (
    SELECT array_agg(DISTINCT c.code)
    FROM (VALUES
      ('Hindi', 'hi'),
      ('English', 'en'),
      ('Bengali', 'bn'),
      ('Telugu', 'te'),
      ('Marathi', 'mr'),
      ('Tamil', 'ta'),
      ('Urdu', 'ur'),
      ('Gujarati', 'gu'),
      ('Kannada', 'kn'),
      ('Malayalam', 'ml'),
      ('Punjabi', 'pa'),
      ('Odia', 'or'),
      ('Assamese', 'as'),
      ('Maithili', 'mai'),
      ('Santali', 'sat'),
      ('Kashmiri', 'ks'),
      ('Manipuri', 'mni'),
      ('Konkani', 'kok'),
      ('Dogri', 'doi'),
      ('Bodo', 'brx'),
      ('Nepali', 'ne'),
      ('Sindhi', 'sd'),
      ('Sanskrit', 'sa'),
      ('Bhojpuri', 'bho'),
      ('Rajasthani', 'raj'),
      ('Chhattisgarhi', 'hne'),
      ('Haryanvi', 'bgc'),
      ('Magahi', 'mag'),
      ('Awadhi', 'awa'),
      ('Tulu', 'tcy'),
      ('Kodava', 'kfa'),
      ('Garhwali', 'gbm'),
      ('Kumaoni', 'kfy'),
      ('Mizo', 'lus'),
      ('Khasi', 'kha'),
      ('Garo', 'grt'),
      ('Nagamese', 'nag'),
      ('Kokborok', 'trp'),
      ('Bishnupriya', 'bpy'),
      ('Goan Konkani', 'gom'),
      ('Tibetan', 'bo'),
      ('Sikkimese', 'sit'),
      ('Sinhala', 'si'),
      ('Dhivehi', 'dv'),
      ('Burmese', 'my'),
      ('Arabic', 'ar'),
      ('Persian', 'fa'),
      ('Pashto', 'ps'),
      ('Turkish', 'tr'),
      ('Russian', 'ru'),
      ('Spanish', 'es'),
      ('French', 'fr'),
      ('German', 'de'),
      ('Portuguese', 'pt'),
      ('Italian', 'it'),
      ('Dutch', 'nl'),
      ('Chinese', 'zh'),
      ('Japanese', 'ja'),
      ('Korean', 'ko'),
      ('Thai', 'th'),
      ('Vietnamese', 'vi'),
      ('Indonesian', 'id'),
      ('Malay', 'ms'),
      ('Filipino', 'tl'),
      ('Swahili', 'sw'),
      ('Amharic', 'am'),
      ('Hebrew', 'he')
    ) AS c(name, code)
    WHERE c.name = ANY (ds."languages")
  ),
  ARRAY[]::text[]
)
WHERE array_length(ds."languages", 1) > 0;

-- The join that made an empty catalogue table unrecoverable.
-- DropForeignKey
ALTER TABLE "user_languages" DROP CONSTRAINT "user_languages_languageCode_fkey";

-- `user_languages.languageCode` stays exactly as it is — a text column holding
-- the codes it already held. Nothing needs rewriting, only un-constraining.
-- DropTable
DROP TABLE "languages";
