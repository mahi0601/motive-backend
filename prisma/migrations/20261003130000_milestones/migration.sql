-- Several milestones per status page, each with its own sign-off. Additive: the
-- old Workspace.milestone* columns stay, unused. Each workspace's single milestone
-- becomes the first row, and the approvals given for its CURRENT version are
-- linked to it, so what is approved today is still approved after the migration.

-- CreateTable
CREATE TABLE "Milestone" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "date" TIMESTAMP(3),
    "position" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Milestone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Milestone_workspaceId_position_idx" ON "Milestone"("workspaceId", "position");

-- AddForeignKey
ALTER TABLE "Milestone" ADD CONSTRAINT "Milestone_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "ClientFeedback" ADD COLUMN "milestoneId" TEXT;

-- AddForeignKey
ALTER TABLE "ClientFeedback" ADD CONSTRAINT "ClientFeedback_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "Milestone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: one milestone per workspace that has one (ids are derived from the
-- workspace id, so they are unique without needing an extension).
INSERT INTO "Milestone" ("id", "workspaceId", "title", "date", "position", "version")
SELECT 'ms' || "id", "id", "milestoneTitle", "milestoneDate", 0, "milestoneVersion"
FROM "Workspace"
WHERE "milestoneTitle" IS NOT NULL AND btrim("milestoneTitle") <> '';

-- Keep today's approvals: sign-offs given for the current version of that milestone.
UPDATE "ClientFeedback" f
SET "milestoneId" = 'ms' || f."workspaceId"
FROM "Workspace" w
WHERE w."id" = f."workspaceId"
  AND w."milestoneTitle" IS NOT NULL AND btrim(w."milestoneTitle") <> ''
  AND f."milestoneVersion" = w."milestoneVersion"
  AND f."kind" IN ('approve', 'changes');
