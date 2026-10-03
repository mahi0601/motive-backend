-- Additive: marks a brand-new Google account (no sign-up checkbox) as needing to agree to
-- the Terms and Privacy Policy before the app is used. Existing accounts default to false.
ALTER TABLE "User" ADD COLUMN "termsPending" BOOLEAN NOT NULL DEFAULT false;
