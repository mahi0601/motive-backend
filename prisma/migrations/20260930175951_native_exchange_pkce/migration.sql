-- Codes live for 60 seconds, so dropping any in-flight rows is harmless — and
-- required, since the new NOT NULL column has no value to backfill them with.
DELETE FROM "NativeExchangeCode";

-- AlterTable
ALTER TABLE "NativeExchangeCode" ADD COLUMN     "codeChallenge" TEXT NOT NULL;
