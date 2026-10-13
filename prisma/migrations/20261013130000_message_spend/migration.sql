-- What a paying account spends on chat messages, in its history: one row per
-- conversation per day (referenceId `msg:<conversation>:<day>`), grown with
-- each paid message.
ALTER TYPE "TransactionKind" ADD VALUE IF NOT EXISTS 'message';

-- The add-or-grow key. Keyed on the reference's prefix rather than on the new
-- kind, which Postgres will not let an index use in the migration that adds it.
CREATE UNIQUE INDEX "wallet_transactions_message_day_key"
  ON "wallet_transactions"("walletId", "referenceId")
  WHERE "referenceId" LIKE 'msg:%';
