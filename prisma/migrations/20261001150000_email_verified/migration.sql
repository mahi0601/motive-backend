-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3);


-- Backfill: Google only returns verified addresses (loginWithGoogle rejects the
-- rest), so every account already linked to Google has proven its email.
UPDATE "User" SET "emailVerifiedAt" = "createdAt" WHERE "googleId" IS NOT NULL;
