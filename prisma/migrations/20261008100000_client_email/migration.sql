-- AlterTable
ALTER TABLE "User" ADD COLUMN     "notifyClientResponsesByEmail" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "statusDigestEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "statusDigestDay" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "statusDigestLastSentAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "StatusSubscriber" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "tokenHash" TEXT NOT NULL,
    "unsubscribedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatusSubscriber_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StatusSubscriber_tokenHash_key" ON "StatusSubscriber"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "StatusSubscriber_workspaceId_email_key" ON "StatusSubscriber"("workspaceId", "email");

-- AddForeignKey
ALTER TABLE "StatusSubscriber" ADD CONSTRAINT "StatusSubscriber_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
