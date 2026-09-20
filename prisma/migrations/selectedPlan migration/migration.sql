-- Persist the plan selected from pricing/signup so it survives
-- email verification and can be used by onboarding/subscription billing.
ALTER TABLE "Seller" ADD COLUMN "selectedPlan" TEXT;
