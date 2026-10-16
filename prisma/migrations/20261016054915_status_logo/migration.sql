-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "statusLogoUpdatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "WorkspaceLogo" (
    "workspaceId" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceLogo_pkey" PRIMARY KEY ("workspaceId")
);

-- AddForeignKey
ALTER TABLE "WorkspaceLogo" ADD CONSTRAINT "WorkspaceLogo_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
