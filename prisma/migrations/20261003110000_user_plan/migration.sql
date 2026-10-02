-- Plans: free | studio | agency. Additive. Everyone who is Pro today (lifetime,
-- or an active subscriber on the old flat plan) keeps everything: Agency.
ALTER TABLE "User" ADD COLUMN "plan" TEXT NOT NULL DEFAULT 'free';
UPDATE "User" SET "plan" = 'agency' WHERE "isPro" = true;
