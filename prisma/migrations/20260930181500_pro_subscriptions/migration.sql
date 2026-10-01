-- AlterTable
ALTER TABLE "User" ADD COLUMN     "proLifetime" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "proPeriodEnd" TIMESTAMP(3),
ADD COLUMN     "stripeSubscriptionId" TEXT,
ADD COLUMN     "subscriptionCancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "subscriptionStatus" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_stripeSubscriptionId_key" ON "User"("stripeSubscriptionId");


-- Grandfathering: everyone who is Pro today bought the one-time lifetime
-- upgrade, so they keep Pro regardless of any subscription's lifecycle.
UPDATE "User" SET "proLifetime" = true WHERE "isPro" = true;
