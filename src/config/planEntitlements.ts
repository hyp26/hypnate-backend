export type PlanId = "starter" | "pro" | "business";

export type PlanFeature =
  | "commerceWorkspace"
  | "catalogAi"
  | "advancedAnalytics"
  | "paymentLinks"
  | "hypnateX";

const PLAN_RANK: Record<PlanId, number> = {
  starter: 1,
  pro: 2,
  business: 3,
};

const FEATURE_MINIMUM_PLAN: Record<PlanFeature, PlanId> = {
  commerceWorkspace: "starter",
  catalogAi: "starter",
  advancedAnalytics: "pro",
  paymentLinks: "pro",
  hypnateX: "business",
};

export function normalizePlan(value: unknown): PlanId | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized === "starter" || normalized === "pro" || normalized === "business"
    ? normalized
    : null;
}

export function hasPlanFeature(plan: unknown, feature: PlanFeature): boolean {
  const planId = normalizePlan(plan);
  if (!planId) return false;
  return PLAN_RANK[planId] >= PLAN_RANK[FEATURE_MINIMUM_PLAN[feature]];
}

export function requiredPlanForFeature(feature: PlanFeature): PlanId {
  return FEATURE_MINIMUM_PLAN[feature];
}
