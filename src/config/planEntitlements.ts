export type PlanId = "starter" | "pro" | "business";
export type BillingCycle = "monthly" | "yearly";
export type PlanFeature = "commerceWorkspace" | "catalogAi" | "advancedAnalytics" | "paymentLinks" | "hypnateX";
export type PlanChannel = "whatsapp" | "instagram" | "facebook" | "telegram";

export const PLAN_RANK: Record<PlanId, number> = { starter: 1, pro: 2, business: 3 };
export const PLAN_PRICES_INR: Record<PlanId, { monthly: number; yearly: number }> = {
  starter: { monthly: 999, yearly: 9588 },
  pro: { monthly: 1999, yearly: 19188 },
  business: { monthly: 5000, yearly: 47988 },
};

const FEATURE_MINIMUM_PLAN: Record<PlanFeature, PlanId> = { 
  commerceWorkspace: "starter", 
  catalogAi: "starter", 
  advancedAnalytics: "pro", 
  paymentLinks: "pro", 
  hypnateX: "business"
 };


const CHANNEL_MINIMUM_PLAN: Record<PlanChannel, PlanId> = { 
  whatsapp: "starter", 
  telegram: "starter", 
  instagram: "pro", 
  facebook: "pro" 
};

export function normalizePlan(value: unknown): PlanId | null {
  if (typeof value !== "string") return null;
  const p = value.trim().toLowerCase();
  return p === "starter" || p === "pro" || p === "business" ? p : null;
}
export function normalizeBillingCycle(value: unknown): 
  BillingCycle | null { return value === "monthly" || value === "yearly" ? value : null; }

export function hasPlanFeature(plan: unknown, feature: PlanFeature): 
  boolean { const p = normalizePlan(plan); return !!p && PLAN_RANK[p] >= PLAN_RANK[FEATURE_MINIMUM_PLAN[feature]]; }

export function requiredPlanForFeature(feature: PlanFeature): 
  PlanId { return FEATURE_MINIMUM_PLAN[feature]; }
  
export function hasPlanChannel(plan: unknown, channel: PlanChannel):
   boolean { const p = normalizePlan(plan); return !!p && PLAN_RANK[p] >= PLAN_RANK[CHANNEL_MINIMUM_PLAN[channel]]; }

export function requiredPlanForChannel(channel: PlanChannel): 
  PlanId { return CHANNEL_MINIMUM_PLAN[channel]; }
