-- Active subscription state is intentionally separate from selectedPlan.
-- selectedPlan records a merchant preference; activePlan is the entitlement source of truth.
ALTER TABLE "Seller" ADD COLUMN IF NOT EXISTS "activePlan" TEXT;
ALTER TABLE "Seller" ADD COLUMN IF NOT EXISTS "planActivatedAt" TIMESTAMP(3);
