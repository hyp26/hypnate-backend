import { Response, NextFunction } from "express";
import prisma from "../prisma/client";
import { AuthRequest } from "./authMiddleware";
import { getPlanAccess } from "../services/billing.service";
import {
  hasPlanFeature,
  requiredPlanForFeature,
  type PlanFeature,
  type PlanId,
} from "../config/planEntitlements";

const PLAN_NAMES: Record<PlanId, string> = {
  starter: "Starter",
  pro: "Pro",
  business: "Business",
};

/**
 * The seller billing fields consumed by the authoritative
 * entitlement decision (getPlanAccess in billing.service).
 * Declared structurally so tests can supply a plain object
 * without Prisma's client-thenable return type.
 */
export interface SellerPlanAccessRow {
  activePlan: string | null;
  planStatus: string | null;
  planCurrentPeriodEnd: Date | null;
  planActivatedAt: Date | null;
  trialPlan: string | null;
  trialEndsAt: Date | null;
}

/**
 * Loads the seller-scoped billing row used for the entitlement
 * decision. prisma.seller.findUnique satisfies this type because
 * PrismaPromise<T> extends Promise<T>.
 */
export type LoadSeller = (sellerId: number) => Promise<SellerPlanAccessRow | null>;

const defaultLoadSeller: LoadSeller = (sellerId) =>
  prisma.seller.findUnique({
    where: { id: sellerId },
    select: {
      activePlan: true,
      planStatus: true,
      planCurrentPeriodEnd: true,
      planActivatedAt: true,
      trialPlan: true,
      trialEndsAt: true,
    },
  });

/**
 * Optional dependency overrides, used by unit tests to stub the
 * seller lookup. Production call sites never pass this.
 */
export interface RequirePlanFeatureDeps {
  loadSeller?: LoadSeller;
}

/**
 * Enforce the selected-plan entitlement server-side.
 * Admins bypass plan checks; seller APIs do not.
 *
 * The access decision is delegated to getPlanAccess() (the same
 * authoritative rules used by the billing-status endpoint), so the
 * middleware and the billing status can never disagree about
 * PENDING / CANCELLED / trial states.
 */
export const requirePlanFeature =
  (feature: PlanFeature, deps: RequirePlanFeatureDeps = {}) =>
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        return res.status(401).json({ message: "Not authenticated" });
      }

      if (req.user.role === "ADMIN") {
        return next();
      }

      const sellerId = req.user.sellerId;
      if (!sellerId) {
        return res.status(403).json({
          message: "Seller account required",
          code: "SELLER_REQUIRED",
        });
      }

      const loadSeller = deps.loadSeller ?? defaultLoadSeller;
      const seller = await loadSeller(sellerId);

      // Authoritative billing-access decision (billing.service).
      const access = getPlanAccess(seller);

      const requiredPlan = requiredPlanForFeature(feature);

      if (!access.hasAccess || !access.plan) {
        return res.status(403).json({
          message: `Your free trial has ended. ${PLAN_NAMES[requiredPlan]} or above is required.`,
          code: "PLAN_REQUIRED",
          requiredPlan,
        });
      }

      const currentPlan = access.plan;
      if (!hasPlanFeature(currentPlan, feature)) {
        return res.status(403).json({
          message: `${PLAN_NAMES[requiredPlan]} or above is required for this feature.`,
          code: "PLAN_UPGRADE_REQUIRED",
          currentPlan,
          requiredPlan,
        });
      }

      return next();
    } catch (error) {
      return next(error);
    }
  };
