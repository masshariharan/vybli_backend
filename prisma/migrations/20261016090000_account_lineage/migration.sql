-- Which account took over a phone number after its holder was deleted.
CREATE TABLE "account_lineage" (
    "previousUserId" TEXT NOT NULL,
    "numberKey" TEXT NOT NULL,
    "successorUserId" TEXT,
    "deletedAt" TIMESTAMP(3) NOT NULL,
    "linkedAt" TIMESTAMP(3),

    CONSTRAINT "account_lineage_pkey" PRIMARY KEY ("previousUserId")
);

CREATE INDEX "account_lineage_numberKey_idx" ON "account_lineage"("numberKey");
CREATE INDEX "account_lineage_successorUserId_idx" ON "account_lineage"("successorUserId");

-- Every account already deleted, keyed by the number its tombstone still
-- carries: country code digits + the last ten digits (see utils/phoneKey).
INSERT INTO "account_lineage" ("previousUserId", "numberKey", "deletedAt")
SELECT
    u."id",
    regexp_replace(COALESCE(u."dialCode", ''), '\D', '', 'g')
      || right(regexp_replace(regexp_replace(u."phone", '^deleted_[^_]*_', ''), '\D', '', 'g'), 10),
    COALESCE(u."deletedAt", u."updatedAt")
FROM "users" u
WHERE u."status" = 'deleted' OR u."deletedAt" IS NOT NULL
ON CONFLICT ("previousUserId") DO NOTHING;
