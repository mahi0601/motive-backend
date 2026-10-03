-- Additive: when, and which version of, the Terms and Privacy Policy a person
-- agreed to at sign-up. Null for existing accounts.
ALTER TABLE "User" ADD COLUMN "termsAcceptedAt" TIMESTAMP(3),
ADD COLUMN "termsVersion" TEXT;
