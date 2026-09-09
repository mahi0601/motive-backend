-- CreateEnum
CREATE TYPE "RecurrenceFrequency" AS ENUM ('daily', 'weekly', 'monthly');

-- DropIndex
DROP INDEX "Page_title_trgm_idx";

-- DropIndex
DROP INDEX "Task_title_trgm_idx";

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "recurrence" "RecurrenceFrequency";
