-- AlterTable
ALTER TABLE "User" ADD COLUMN     "cashfreeSubscriptionId" TEXT,
ADD COLUMN     "paypalSubscriptionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_paypalSubscriptionId_key" ON "User"("paypalSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "User_cashfreeSubscriptionId_key" ON "User"("cashfreeSubscriptionId");
