export type PlanId = "starter" | "pro" | "business";

export type PlanFeature =
  | "commerceWorkspace"
  | "catalogAi"
  | "advancedAnalytics"
  | "paymentLinks"
  | "hypnateX";

export type PlanChannel = "whatsapp" | "instagram" | "facebook" | "telegram";

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

const CHANNEL_MINIMUM_PLAN: Record<PlanChannel, PlanId> = {
  whatsapp: "starter",
  telegram: "starter",
  instagram: "pro",
  facebook: "pro",
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


export function hasPlanChannel(plan: unknown, channel: PlanChannel): boolean {
  const planId = normalizePlan(plan);
  if (!planId) return false;
  return PLAN_RANK[planId] >= PLAN_RANK[CHANNEL_MINIMUM_PLAN[channel]];
}

export function requiredPlanForChannel(channel: PlanChannel): PlanId {
  return CHANNEL_MINIMUM_PLAN[channel];
}

export const PLAN_CHANNELS: Record<PlanId, PlanChannel[]> = {
  starter: ["whatsapp", "telegram"],
  pro: ["whatsapp", "telegram", "instagram", "facebook"],
  business: ["whatsapp", "telegram", "instagram", "facebook"],
};

export function getPlanChannels(plan: unknown): PlanChannel[] {
  const planId = normalizePlan(plan);
  return planId ? PLAN_CHANNELS[planId] : [];
}
