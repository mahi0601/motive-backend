-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "statusAllowFeedback" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ClientFeedback" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "message" TEXT NOT NULL DEFAULT '',
    "milestoneTitle" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClientFeedback_workspaceId_createdAt_idx" ON "ClientFeedback"("workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "ClientFeedback" ADD CONSTRAINT "ClientFeedback_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

