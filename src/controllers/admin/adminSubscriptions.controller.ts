import { Request, Response, NextFunction } from "express";
import prisma from "../../prisma/client";
import { AdminAuthRequest } from "../../middleware/adminAuth.middleware";
import {
  listSubscriptionsSchema,
  updateSubscriptionSchema,
} from "../../schemas/admin.schemas";
import { recordAudit } from "../../services/adminAudit.service";

/* ----------------------------------------------------
   HELPERS
---------------------------------------------------- */

/**
 * Derive a frontend-compatible subscription status from
 * the seller's billing columns:
 *
 *  - explicit planStatus when present
 *  - otherwise active trial => TRIALING
 *  - otherwise ACTIVE
 */
const deriveSubscriptionStatus = (seller: {
  planStatus: string | null;
  trialEndsAt: Date | null;
}): string => {
  if (seller.planStatus) {
    return seller.planStatus;
  }

  if (seller.trialEndsAt && seller.trialEndsAt > new Date()) {
    return "TRIALING";
  }

  return "ACTIVE";
};

const serializeSubscription = (seller: {
  id: number;
  businessName: string;
  trialPlan: string | null;
  trialStartedAt: Date | null;
  trialEndsAt: Date | null;
  activePlan: string | null;
  planStatus: string | null;
  planActivatedAt: Date | null;
  planCurrentPeriodEnd: Date | null;
  billingCycle: string | null;
  razorpaySubscriptionId: string | null;
  createdAt: Date;
  users: { email: string }[];
}) => ({
  id: `sub-${seller.id}`,
  sellerId: seller.id,
  seller: {
    id: seller.id,
    businessName: seller.businessName,
    email: seller.users[0]?.email ?? "",
  },
  plan: seller.activePlan ?? seller.trialPlan ?? "FREE",
  status: deriveSubscriptionStatus(seller),
  currentPeriodStart: seller.planActivatedAt?.toISOString() ?? undefined,
  currentPeriodEnd:
    seller.planCurrentPeriodEnd?.toISOString() ?? seller.trialEndsAt?.toISOString() ?? undefined,
  trialStart: seller.trialStartedAt?.toISOString() ?? undefined,
  trialEnd: seller.trialEndsAt?.toISOString() ?? undefined,
  billingCycle: (seller.billingCycle as "MONTHLY" | "YEARLY" | null) ?? "MONTHLY",
  amount: 0,
  currency: "INR",
  paymentMethod: seller.razorpaySubscriptionId ? "razorpay" : undefined,
  createdAt: seller.createdAt.toISOString(),
});

/* ----------------------------------------------------
   GET /api/admin/subscriptions
---------------------------------------------------- */

export const listSubscriptions = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const parsed = listSubscriptionsSchema.safeParse(req);

    if (!parsed.success) {
      res.status(400).json({
        message: parsed.error.issues[0]?.message ?? "Invalid request",
      });
      return;
    }

    const { page, limit, plan, status } = parsed.data.query;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};

    if (plan) {
      where.OR = [{ activePlan: plan }, { trialPlan: plan }];
    }

    if (status && status !== "TRIALING") {
      where.planStatus = status;
    } else if (status === "TRIALING") {
      where.planStatus = null;
      where.trialEndsAt = { gt: new Date() };
    }

    const [sellers, total] = await Promise.all([
      prisma.seller.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        select: {
          id: true,
          businessName: true,
          trialPlan: true,
          trialStartedAt: true,
          trialEndsAt: true,
          activePlan: true,
          planStatus: true,
          planActivatedAt: true,
          planCurrentPeriodEnd: true,
          billingCycle: true,
          razorpaySubscriptionId: true,
          createdAt: true,
          users: {
            take: 1,
            orderBy: { createdAt: "asc" },
            select: { email: true },
          },
        },
      }),
      prisma.seller.count({ where }),
    ]);

    res.json({
      data: sellers.map(serializeSubscription),
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   PATCH /api/admin/subscriptions/:id   (id = seller id)
---------------------------------------------------- */

export const updateSubscription = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = Number(req.params.id);

    if (!Number.isInteger(sellerId) || sellerId <= 0) {
      res.status(400).json({ message: "Invalid subscription id" });
      return;
    }

    const parsed = updateSubscriptionSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        message: parsed.error.issues[0]?.message ?? "Invalid request",
      });
      return;
    }

    const seller = await prisma.seller.findUnique({
      where: { id: sellerId },
      select: {
        id: true,
        activePlan: true,
        planStatus: true,
      },
    });

    if (!seller) {
      res.status(404).json({ message: "Subscription not found" });
      return;
    }

    const data: Record<string, unknown> = {};

    if (parsed.data.plan) {
      data.activePlan = parsed.data.plan;

      if (!seller.planStatus) {
        data.planStatus = "ACTIVE";
      }
    }

    if (parsed.data.status) {
      data.planStatus = parsed.data.status;
    }

    const updated = await prisma.seller.update({
      where: { id: sellerId },
      data,
      select: {
        id: true,
        businessName: true,
        trialPlan: true,
        trialStartedAt: true,
        trialEndsAt: true,
        activePlan: true,
        planStatus: true,
        planActivatedAt: true,
        planCurrentPeriodEnd: true,
        billingCycle: true,
        razorpaySubscriptionId: true,
        createdAt: true,
        users: { take: 1, select: { email: true } },
      },
    });

    await recordAudit({
      actorId: req.adminUser!.id,
      action: "UPDATE",
      entityType: "Subscription",
      entityId: sellerId,
      oldValue: {
        plan: seller.activePlan,
        status: seller.planStatus,
      },
      newValue: {
        plan: updated.activePlan,
        status: updated.planStatus,
      },
      req,
    });

    res.json({ subscription: serializeSubscription(updated) });
  } catch (err) {
    next(err);
  }
};
