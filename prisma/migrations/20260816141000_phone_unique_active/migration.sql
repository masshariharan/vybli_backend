-- A phone number is unique among *live* accounts only.
--
-- A deleted account keeps its row, because call history, ledger entries and
-- the other side of every conversation reference it. But its number must be
-- reusable — someone deleting their account and signing up again with the same
-- phone is ordinary, not an error. A plain UNIQUE constraint cannot express
-- "unique where not deleted", so it is a partial index.
CREATE UNIQUE INDEX "users_phone_dial_code_active_key"
  ON "users" ("dialCode", "phone")
  WHERE "deletedAt" IS NULL;
