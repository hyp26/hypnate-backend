# Plan Feature Enforcement

## Entitlement model

The current pilot uses `Seller.selectedPlan` as the plan entitlement source:

- `starter`
- `pro`
- `business`

Plan minimums:

| Capability | Minimum plan |
|---|---|
| Core commerce workspace | Starter |
| Catalog AI assistance | Starter |
| Advanced analytics | Pro |
| Payment-link generation | Pro |
| Hypnate X website builder | Business |

## Backend enforcement

`src/middleware/plan.middleware.ts` provides `requirePlanFeature()` and is applied to protected API routes.

Core seller APIs require Starter entitlement. Analytics requires Pro+. Payment-link creation requires Pro+. Hypnate X merchant APIs require Business.

Missing or invalid plans return `403 PLAN_REQUIRED`. Lower plans return `403 PLAN_UPGRADE_REQUIRED`.

Admin users bypass merchant plan checks.

## Signup / onboarding

Public registration requires a valid selected plan and persists it on `Seller.selectedPlan`. Onboarding can save the selected plan for existing planless sellers so they cannot enter the merchant application without an entitlement.

## Migration

`Seller.selectedPlan` is represented in `prisma/schema.prisma`. The migration uses `ADD COLUMN IF NOT EXISTS` so deployments are safe when the column was already added by a prior hotfix.

If the deployment database already has a recorded migration with the same migration name, keep the existing migration history and do not create a duplicate migration.
