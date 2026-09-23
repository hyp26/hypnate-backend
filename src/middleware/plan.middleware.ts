import { Response, NextFunction } from "express";
import prisma from "../prisma/client";
import { AuthRequest } from "./authMiddleware";
import {
  hasPlanFeature,
  requiredPlanForFeature,
  normalizePlan,
  type PlanFeature,
  type PlanId,
} from "../config/planEntitlements";

const PLAN_NAMES: Record<PlanId, string> = {
  starter: "Starter",
  pro: "Pro",
  business: "Business",
};

/**
 * Enforce the selected-plan entitlement server-side.
 * Admins bypass plan checks; seller APIs do not.
 */
export const requirePlanFeature = (feature: PlanFeature) => async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
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

    const seller = await prisma.seller.findUnique({
      where: { id: sellerId },
      select: {
        activePlan: true,
        planStatus: true,
        planCurrentPeriodEnd: true,
        trialPlan: true,
        trialEndsAt: true,
      },
    });

    const now = new Date();
    const paidPlan = normalizePlan(seller?.activePlan);
    const paidPeriodEnd = seller?.planCurrentPeriodEnd
      ? new Date(seller.planCurrentPeriodEnd)
      : null;
    const trialPlan = normalizePlan(seller?.trialPlan);
    const trialEndsAt = seller?.trialEndsAt ? new Date(seller.trialEndsAt) : null;

    const currentPlan =
      paidPlan &&
      ["ACTIVE", "PENDING", "CANCELLED"].includes(String(seller?.planStatus || "").toUpperCase()) &&
      (!paidPeriodEnd || paidPeriodEnd > now)
        ? paidPlan
        : trialPlan && trialEndsAt && trialEndsAt > now
          ? trialPlan
          : null;

    const requiredPlan = requiredPlanForFeature(feature);

    if (!currentPlan) {
      return res.status(403).json({
        message: `Your free trial has ended. ${PLAN_NAMES[requiredPlan]} or above is required.`,
        code: "PLAN_REQUIRED",
        requiredPlan,
      });
    }

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
