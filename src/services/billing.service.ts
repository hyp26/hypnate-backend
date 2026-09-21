import crypto from "crypto";
import prisma from "../prisma/client";
import { ENV } from "../config/env";
import { normalizeBillingCycle, normalizePlan, PLAN_PRICES_INR, type BillingCycle, type PlanId } from "../config/planEntitlements";

const API = "https://api.razorpay.com/v1";
export const TRIAL_DAYS = 7;
export const getTrialEndDate = (start: Date) => new Date(start.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

export function getPlanAccess(seller: any) {
  const now = new Date();
  const activePlan = normalizePlan(seller?.activePlan);
  const status = String(seller?.planStatus || "").toUpperCase();
  const periodEnd = seller?.planCurrentPeriodEnd ? new Date(seller.planCurrentPeriodEnd) : null;
  const paidAccess = !!activePlan && ["ACTIVE", "PENDING", "CANCELLED"].includes(status) && (!periodEnd || periodEnd > now);
  if (paidAccess) return { hasAccess: true, source: "paid" as const, plan: activePlan, status, trialEndsAt: null, planCurrentPeriodEnd: periodEnd };
  const trialPlan = normalizePlan(seller?.trialPlan);
  const trialEndsAt = seller?.trialEndsAt ? new Date(seller.trialEndsAt) : null;
  if (trialPlan && trialEndsAt && trialEndsAt > now) return { hasAccess: true, source: "trial" as const, plan: trialPlan, status: "TRIALING", trialEndsAt, planCurrentPeriodEnd: null };
  return { hasAccess: false, source: null, plan: null, status: status || "NONE", trialEndsAt, planCurrentPeriodEnd: periodEnd };
}

function authHeader() {
  if (!ENV.RAZORPAY_KEY_ID || !ENV.RAZORPAY_KEY_SECRET) { const e = new Error("Razorpay is not configured"); (e as any).status = 503; throw e; }
  return `Basic ${Buffer.from(`${ENV.RAZORPAY_KEY_ID}:${ENV.RAZORPAY_KEY_SECRET}`).toString("base64")}`;
}

async function razorpay<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, { ...options, headers: { "Content-Type": "application/json", Authorization: authHeader(), ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) { const e = new Error(body?.error?.description || "Razorpay request failed"); (e as any).status = response.status >= 500 ? 502 : response.status; throw e; }
  return body as T;
}

export function getRazorpayPlanId(planValue: unknown, cycleValue: unknown): string | null {
  const plan = normalizePlan(planValue); const cycle = normalizeBillingCycle(cycleValue); if (!plan || !cycle) return null;
  const key = `RAZORPAY_PLAN_${plan.toUpperCase()}_${cycle.toUpperCase()}` as keyof typeof ENV;
  const value = ENV[key]; return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function verifySubscriptionSignature({ subscriptionId, paymentId, signature }: { subscriptionId: string; paymentId: string; signature: string }) {
  if (!ENV.RAZORPAY_KEY_SECRET || !signature) return false;
  const expected = crypto.createHmac("sha256", ENV.RAZORPAY_KEY_SECRET).update(`${paymentId}|${subscriptionId}`).digest("hex");
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function verifyWebhookSignature(rawBody: Buffer, signature: string) {
  if (!ENV.RAZORPAY_WEBHOOK_SECRET || !signature) return false;
  const expected = crypto.createHmac("sha256", ENV.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest("hex");
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export async function createSubscriptionForSeller({ sellerId, planValue, cycleValue, customer }: { sellerId: number; planValue: unknown; cycleValue: unknown; customer: { name?: string; email: string; contact?: string } }) {
  const plan = normalizePlan(planValue); const cycle = normalizeBillingCycle(cycleValue);
  if (!plan || !cycle) { const e = new Error("Invalid plan or billing cycle"); (e as any).status = 400; throw e; }
  const razorpayPlanId = getRazorpayPlanId(plan, cycle);
  if (!razorpayPlanId) { const e = new Error(`Razorpay ${plan} ${cycle} plan is not configured`); (e as any).status = 503; throw e; }
  const seller = await prisma.seller.findUnique({ where: { id: sellerId } });
  if (!seller) { const e = new Error("Seller not found"); (e as any).status = 404; throw e; }
  const access = getPlanAccess(seller);
  if (access.source === "paid" && access.plan === plan) { const e = new Error("This plan is already active on the account"); (e as any).status = 409; throw e; }

  if (seller.razorpaySubscriptionId) {
    const old = await razorpay<any>(`/subscriptions/${seller.razorpaySubscriptionId}`);
    if (["created", "authenticated", "active", "pending"].includes(String(old.status))) { const e = new Error("A Razorpay subscription is already pending or active"); (e as any).status = 409; throw e; }
  }

  const amount = PLAN_PRICES_INR[plan][cycle];
  const subscription = await razorpay<any>("/subscriptions", { method: "POST", body: JSON.stringify({
    plan_id: razorpayPlanId, total_count: cycle === "monthly" ? 120 : 10, quantity: 1, customer_notify: true,
    notes: { seller_id: String(sellerId), hypnate_plan: plan, billing_cycle: cycle, amount_inr: String(amount) },
  }) });

  await prisma.seller.update({ where: { id: sellerId }, data: { selectedPlan: plan, razorpaySubscriptionId: subscription.id, razorpayPlanId, billingCycle: cycle, planStatus: String(subscription.status || "created").toUpperCase() } });
  return { keyId: ENV.RAZORPAY_KEY_ID, subscriptionId: subscription.id, plan, billingCycle: cycle, amount, currency: "INR", customer };
}

export async function activatePaidPlanFromSubscription(subscriptionId: string) {
  const subscription = await razorpay<any>(`/subscriptions/${subscriptionId}`);
  const seller = await prisma.seller.findFirst({ where: { razorpaySubscriptionId: subscriptionId } });
  if (!seller) return { updated: false, reason: "SELLER_NOT_FOUND" };
  const plan = normalizePlan(seller.selectedPlan) || normalizePlan(subscription.notes?.hypnate_plan);
  if (!plan) return { updated: false, reason: "PLAN_NOT_FOUND" };
  const status = String(subscription.status || "").toLowerCase();
  const currentEnd = subscription.current_end ? new Date(Number(subscription.current_end) * 1000) : null;
  const isActive = status === "active";
  await prisma.seller.update({ where: { id: seller.id }, data: { activePlan: isActive ? plan : seller.activePlan, planStatus: String(subscription.status || "UNKNOWN").toUpperCase(), planActivatedAt: isActive ? (seller.planActivatedAt || new Date()) : seller.planActivatedAt, planCurrentPeriodEnd: currentEnd, razorpayPlanId: seller.razorpayPlanId || subscription.plan_id || null } });
  return { updated: true, sellerId: seller.id, plan, status };
}

export async function clearPaidPlanFromSubscription(subscriptionId: string, status: string) {
  const seller = await prisma.seller.findFirst({ where: { razorpaySubscriptionId: subscriptionId } });
  if (!seller) return { updated: false };
  await prisma.seller.update({ where: { id: seller.id }, data: { activePlan: null, planStatus: status.toUpperCase(), planCurrentPeriodEnd: null } });
  return { updated: true, sellerId: seller.id };
}
