import { Request, Response, NextFunction } from "express";
import prisma from "../../prisma/client";
import { AdminAuthRequest } from "../../middleware/adminAuth.middleware";
import { listSellersSchema, updateSellerStatusSchema } from "../../schemas/admin.schemas";
import { recordAudit } from "../../services/adminAudit.service";

/* ----------------------------------------------------
   HELPERS
---------------------------------------------------- */

/**
 * Derive a frontend-compatible status:
 *
 *  - explicit SUSPENDED / INACTIVE wins
 *  - active trial => TRIALING
 *  - otherwise ACTIVE
 */
const deriveStatus = (seller: {
  status: string;
  trialEndsAt: Date | null;
}): string => {
  if (seller.status === "SUSPENDED" || seller.status === "INACTIVE") {
    return seller.status;
  }

  if (seller.trialEndsAt && seller.trialEndsAt > new Date()) {
    return "TRIALING";
  }

  return "ACTIVE";
};

const serializeSeller = (
  seller: {
    id: number;
    businessName: string;
    phone: string | null;
    status: string;
    trialPlan: string | null;
    trialStartedAt: Date | null;
    trialEndsAt: Date | null;
    activePlan: string | null;
    planStatus: string | null;
    planActivatedAt: Date | null;
    planCurrentPeriodEnd: Date | null;
    billingCycle: string | null;
    onboardedAt: Date | null;
    createdAt: Date;
    users: {
      email: string;
      name: string;
    }[];
  },
  metrics: {
    totalRevenue: number;
    totalOrders: number;
    totalProducts: number;
  }
) => {
  const owner = seller.users[0];

  const nameParts = (owner?.name ?? "").trim().split(/\s+/);

  return {
    id: seller.id,
    email: owner?.email ?? "",
    businessName: seller.businessName,
    firstName: nameParts[0] ?? "",
    lastName: nameParts.slice(1).join(" "),
    status: deriveStatus(seller),
    phone: seller.phone ?? undefined,
    plan: seller.activePlan ?? seller.trialPlan ?? "FREE",
    subscriptionStatus: seller.planStatus ?? undefined,
    trialStart: seller.trialStartedAt?.toISOString() ?? undefined,
    trialEndsAt: seller.trialEndsAt?.toISOString() ?? undefined,
    totalRevenue: metrics.totalRevenue,
    totalOrders: metrics.totalOrders,
    totalProducts: metrics.totalProducts,
    onboardedAt: seller.onboardedAt?.toISOString() ?? undefined,
    createdAt: seller.createdAt.toISOString(),
  };
};

/* ----------------------------------------------------
   GET /api/admin/sellers
---------------------------------------------------- */

export const listSellers = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const parsed = listSellersSchema.safeParse(req);

    if (!parsed.success) {
      res.status(400).json({
        message: parsed.error.issues[0]?.message ?? "Invalid request",
      });
      return;
    }

    const { page, limit, search, status, plan, sort } = parsed.data.query;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};

    if (search) {
      where.OR = [
        { businessName: { contains: search, mode: "insensitive" } },
        { users: { some: { email: { contains: search, mode: "insensitive" } } } },
      ];
    }

    if (status === "SUSPENDED" || status === "INACTIVE") {
      where.status = status;
    } else if (status === "TRIALING") {
      where.status = "ACTIVE";
      where.trialEndsAt = { gt: new Date() };
    } else if (status === "ACTIVE") {
      where.status = "ACTIVE";
    }

    if (plan) {
      where.OR = [
        ...(Array.isArray(where.OR) ? (where.OR as unknown[]) : []),
        { activePlan: plan },
        { trialPlan: plan },
      ];
    }

    const orderBy: Record<string, string> =
      sort === "createdAt_asc"
        ? { createdAt: "asc" }
        : { createdAt: "desc" };

    const [sellers, total] = await Promise.all([
      prisma.seller.findMany({
        where,
        orderBy,
        skip,
        take: limit,
        select: {
          id: true,
          businessName: true,
          phone: true,
          status: true,
          trialPlan: true,
          trialStartedAt: true,
          trialEndsAt: true,
          activePlan: true,
          planStatus: true,
          planActivatedAt: true,
          planCurrentPeriodEnd: true,
          billingCycle: true,
          onboardedAt: true,
          createdAt: true,
          users: {
            take: 1,
            orderBy: { createdAt: "asc" },
            select: { email: true, name: true },
          },
        },
      }),
      prisma.seller.count({ where }),
    ]);

    // Bulk metrics for just this page of sellers.
    const sellerIds = sellers.map((s) => s.id);

    const [revenueBySeller, ordersBySeller, productsBySeller] =
      sellerIds.length
        ? await Promise.all([
            prisma.order.groupBy({
              by: ["sellerId"],
              where: {
                sellerId: { in: sellerIds },
                paymentStatus: "PAID",
              },
              _sum: { totalAmount: true },
            }),
            prisma.order.groupBy({
              by: ["sellerId"],
              where: { sellerId: { in: sellerIds } },
              _count: { id: true },
            }),
            prisma.product.groupBy({
              by: ["sellerId"],
              where: { sellerId: { in: sellerIds } },
              _count: { id: true },
            }),
          ])
        : [[], [], []];

    const revenueMap = new Map(
      revenueBySeller.map((r) => [r.sellerId, r._sum.totalAmount ?? 0])
    );
    const ordersMap = new Map(
      ordersBySeller.map((r) => [r.sellerId, r._count.id])
    );
    const productsMap = new Map(
      productsBySeller.map((r) => [r.sellerId, r._count.id])
    );

    const data = sellers.map((seller) =>
      serializeSeller(seller, {
        totalRevenue: Math.round(revenueMap.get(seller.id) ?? 0),
        totalOrders: ordersMap.get(seller.id) ?? 0,
        totalProducts: productsMap.get(seller.id) ?? 0,
      })
    );

    if (sort === "revenue_desc") {
      data.sort((a, b) => b.totalRevenue - a.totalRevenue);
    }

    res.json({
      data,
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
   GET /api/admin/sellers/:id
---------------------------------------------------- */

export const getSeller = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ message: "Invalid seller id" });
      return;
    }

    const seller = await prisma.seller.findUnique({
      where: { id },
      select: {
        id: true,
        businessName: true,
        phone: true,
        status: true,
        gstNumber: true,
        industry: true,
        businessSize: true,
        selectedPlan: true,
        trialPlan: true,
        trialStartedAt: true,
        trialEndsAt: true,
        activePlan: true,
        planStatus: true,
        planActivatedAt: true,
        planCurrentPeriodEnd: true,
        billingCycle: true,
        onboardedAt: true,
        createdAt: true,
        users: {
          select: { id: true, email: true, name: true, createdAt: true },
        },
      },
    });

    if (!seller) {
      res.status(404).json({ message: "Seller not found" });
      return;
    }

    const [revenueAgg, orderCount, productCount, customerCount, recentOrders] =
      await Promise.all([
        prisma.order.aggregate({
          where: { sellerId: id, paymentStatus: "PAID" },
          _sum: { totalAmount: true },
        }),
        prisma.order.count({ where: { sellerId: id } }),
        prisma.product.count({ where: { sellerId: id } }),
        prisma.customer.count({ where: { sellerId: id } }),
        prisma.order.findMany({
          where: { sellerId: id },
          orderBy: { createdAt: "desc" },
          take: 10,
          select: {
            id: true,
            customerName: true,
            totalAmount: true,
            status: true,
            paymentStatus: true,
            createdAt: true,
          },
        }),
      ]);

    res.json({
      seller: {
        ...seller,
        metrics: {
          totalRevenue: Math.round(revenueAgg._sum.totalAmount ?? 0),
          totalOrders: orderCount,
          totalProducts: productCount,
          totalCustomers: customerCount,
        },
        recentOrders,
      },
    });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   PATCH /api/admin/sellers/:id/status
---------------------------------------------------- */

export const updateSellerStatus = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ message: "Invalid seller id" });
      return;
    }

    const parsed = updateSellerStatusSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        message: parsed.error.issues[0]?.message ?? "Invalid request",
      });
      return;
    }

    const seller = await prisma.seller.findUnique({
      where: { id },
      select: { id: true, status: true, businessName: true },
    });

    if (!seller) {
      res.status(404).json({ message: "Seller not found" });
      return;
    }

    const updated = await prisma.seller.update({
      where: { id },
      data: { status: parsed.data.status },
    });

    // Suspend / deactivate also revokes the seller users'
    // refresh sessions so they cannot silently keep access.
    if (parsed.data.status !== "ACTIVE") {
      const sellerUsers = await prisma.user.findMany({
        where: { sellerId: id },
        select: { id: true },
      });

      if (sellerUsers.length > 0) {
        await prisma.refreshSession.updateMany({
          where: {
            userId: { in: sellerUsers.map((u) => u.id) },
            revokedAt: null,
          },
          data: { revokedAt: new Date() },
        });
      }
    }

    await recordAudit({
      actorId: req.adminUser!.id,
      action: "UPDATE",
      entityType: "Seller",
      entityId: id,
      oldValue: { status: seller.status },
      newValue: { status: updated.status },
      req,
    });

    res.json({ seller: updated });
  } catch (err) {
    next(err);
  }
};
