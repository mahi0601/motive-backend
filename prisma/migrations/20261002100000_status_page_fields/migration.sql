-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "milestoneDate" TIMESTAMP(3),
ADD COLUMN     "milestoneTitle" TEXT,
ADD COLUMN     "statusAccent" TEXT NOT NULL DEFAULT 'teal',
ADD COLUMN     "statusHeadline" TEXT,
ADD COLUMN     "statusHideBranding" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "statusSummary" TEXT;

