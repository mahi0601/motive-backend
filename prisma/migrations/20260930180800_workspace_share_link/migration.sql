-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "shareEnabledAt" TIMESTAMP(3),
ADD COLUMN     "shareTokenHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_shareTokenHash_key" ON "Workspace"("shareTokenHash");

