-- Saved client templates: a sanitised copy of a client's structure that an owner can reuse.
-- Additive. Deleting a user deletes their templates.

-- CreateTable
CREATE TABLE "ClientTemplate" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClientTemplate_ownerId_createdAt_idx" ON "ClientTemplate"("ownerId", "createdAt");

-- AddForeignKey
ALTER TABLE "ClientTemplate" ADD CONSTRAINT "ClientTemplate_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
