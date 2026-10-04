-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "statusAllowRequests" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ClientRequest" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "details" TEXT NOT NULL DEFAULT '',
    "authorName" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'received',
    "scope" TEXT,
    "declineNote" TEXT,
    "taskId" TEXT,
    "readAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClientRequest_taskId_key" ON "ClientRequest"("taskId");

-- CreateIndex
CREATE INDEX "ClientRequest_workspaceId_createdAt_idx" ON "ClientRequest"("workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "ClientRequest" ADD CONSTRAINT "ClientRequest_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientRequest" ADD CONSTRAINT "ClientRequest_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
