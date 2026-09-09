-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "Notification_userId_read_idx" ON "Notification"("userId", "read");

-- CreateIndex
CREATE INDEX "Task_userId_status_idx" ON "Task"("userId", "status");

-- CreateIndex
CREATE INDEX "Task_userId_category_idx" ON "Task"("userId", "category");

-- Trigram indexes so `title ILIKE '%term%'` (used by task/page search) can
-- use an index instead of a full sequential scan. Cheap stopgap ahead of a
-- proper tsvector full-text column (see Part 4 Phase 2 of the scaling plan).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "Task_title_trgm_idx" ON "Task" USING GIN ("title" gin_trgm_ops);
CREATE INDEX "Page_title_trgm_idx" ON "Page" USING GIN ("title" gin_trgm_ops);
