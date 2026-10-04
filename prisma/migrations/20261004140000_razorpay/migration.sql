-- AlterTable
ALTER TABLE "User" ADD COLUMN     "paymentProvider" TEXT,
ADD COLUMN     "razorpaySubscriptionId" TEXT;

-- CreateTable
CREATE TABLE "ProviderPlan" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "providerPlanId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderPlan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProviderPlan_provider_plan_currency_amount_key" ON "ProviderPlan"("provider", "plan", "currency", "amount");

-- CreateIndex
CREATE UNIQUE INDEX "User_razorpaySubscriptionId_key" ON "User"("razorpaySubscriptionId");

-- Everyone who already has a Stripe subscription is recorded as a Stripe customer.
UPDATE "User" SET "paymentProvider" = 'stripe' WHERE "stripeSubscriptionId" IS NOT NULL OR "stripeCustomerId" IS NOT NULL;
