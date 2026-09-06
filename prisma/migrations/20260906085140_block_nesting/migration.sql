-- AlterTable
ALTER TABLE "Block" ADD COLUMN     "parentBlockId" TEXT;

-- CreateIndex
CREATE INDEX "Block_parentBlockId_idx" ON "Block"("parentBlockId");

-- AddForeignKey
ALTER TABLE "Block" ADD CONSTRAINT "Block_parentBlockId_fkey" FOREIGN KEY ("parentBlockId") REFERENCES "Block"("id") ON DELETE CASCADE ON UPDATE CASCADE;
