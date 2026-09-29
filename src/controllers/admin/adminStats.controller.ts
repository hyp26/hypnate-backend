import { Request, Response, NextFunction } from "express";
import prisma from "../../prisma/client";
import { AdminAuthRequest } from "../../middleware/adminAuth.middleware";

/* ----------------------------------------------------
   HELPERS
---------------------------------------------------- */

const calcGrowth = (current: number, previous: number): number => {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 100 * 10) / 10;
};

/* ----------------------------------------------------
   GET /api/admin/stats
---------------------------------------------------- */

/**
 * Platform-wide totals for the admin dashboard.
 * Matches the frontend `Stats` interface.
 */
export const getAdminStats = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const now = new Date();

    const thisMonthStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      1
    );

    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const [
      totalSellers,
      totalCustomers,
      totalOrders,
      revenueAgg,
      activeSubscriptions,
      pendingTickets,
      newSignups,
      revenueThisMonthAgg,
      revenueLastMonthAgg,
    ] = await Promise.all([
      prisma.seller.count(),
      prisma.customer.count(),
      prisma.order.count(),
      prisma.order.aggregate({
        where: { paymentStatus: "PAID" },
        _sum: { totalAmount: true },
      }),
      prisma.seller.count({
        where: { planStatus: "ACTIVE" },
      }),
      prisma.supportTicket.count({
        where: { status: { in: ["OPEN", "PENDING", "IN_PROGRESS"] } },
      }),
      prisma.seller.count({
        where: { createdAt: { gte: thisMonthStart } },
      }),
      prisma.order.aggregate({
        where: {
          paymentStatus: "PAID",
          createdAt: { gte: thisMonthStart },
        },
        _sum: { totalAmount: true },
      }),
      prisma.order.aggregate({
        where: {
          paymentStatus: "PAID",
          createdAt: { gte: lastMonthStart, lt: thisMonthStart },
        },
        _sum: { totalAmount: true },
      }),
    ]);

    const revenueThisMonth = revenueThisMonthAgg._sum.totalAmount ?? 0;
    const revenueLastMonth = revenueLastMonthAgg._sum.totalAmount ?? 0;

    res.json({
      stats: {
        totalSellers,
        totalCustomers,
        totalOrders,
        totalRevenue: Math.round(revenueAgg._sum.totalAmount ?? 0),
        activeSubscriptions,
        pendingTickets,
        newSignups,
        revenueThisMonth: Math.round(revenueThisMonth),
        revenueGrowth: calcGrowth(revenueThisMonth, revenueLastMonth),
      },
    });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   GET /api/admin/stats/charts?days=30
---------------------------------------------------- */

/**
 * Daily revenue / order chart data in the frontend's
 * ChartData shape.
 */
export const getRevenueChart = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const days = Math.min(
      Math.max(Number(req.query.days) || 30, 7),
      90
    );

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const start = new Date(todayStart);
    start.setDate(start.getDate() - (days - 1));

    const orders = await prisma.order.findMany({
      where: {
        createdAt: { gte: start },
      },
      select: {
        totalAmount: true,
        paymentStatus: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    });

    const buckets = new Map<string, { revenue: number; orders: number }>();

    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      buckets.set(d.toISOString().slice(0, 10), { revenue: 0, orders: 0 });
    }

    for (const order of orders) {
      const key = order.createdAt.toISOString().slice(0, 10);
      const bucket = buckets.get(key);

      if (!bucket) continue;

      bucket.orders += 1;

      if (order.paymentStatus === "PAID") {
        bucket.revenue += order.totalAmount;
      }
    }

    const labels = [...buckets.keys()];

    res.json({
      chartData: {
        labels,
        datasets: [
          {
            label: "Revenue",
            data: [...buckets.values()].map((b) => Math.round(b.revenue)),
          },
          {
            label: "Orders",
            data: [...buckets.values()].map((b) => b.orders),
          },
        ],
      },
    });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   GET /api/admin/analytics
---------------------------------------------------- */

/**
 * Longer-horizon analytics: 12-month growth series,
 * plan distribution, order status and ticket breakdowns.
 */
export const getAdminAnalytics = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const now = new Date();
    const yearAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1);

    const [
      sellers,
      customers,
      orders,
      sellerPlans,
      orderStatusCounts,
      ticketStatusCounts,
    ] = await Promise.all([
      prisma.seller.findMany({
        where: { createdAt: { gte: yearAgo } },
        select: { createdAt: true },
      }),
      prisma.customer.findMany({
        where: { createdAt: { gte: yearAgo } },
        select: { createdAt: true },
      }),
      prisma.order.findMany({
        where: { createdAt: { gte: yearAgo } },
        select: { totalAmount: true, paymentStatus: true, createdAt: true },
      }),
      prisma.seller.groupBy({
        by: ["activePlan"],
        _count: { id: true },
      }),
      prisma.order.groupBy({
        by: ["status"],
        _count: { id: true },
      }),
      prisma.supportTicket.groupBy({
        by: ["status"],
        _count: { id: true },
      }),
    ]);

    // ── Build 12-month buckets ──────────────────────────────────────
    const months: string[] = [];
    const counts = {
      sellers: [] as number[],
      customers: [] as number[],
      orders: [] as number[],
      revenue: [] as number[],
    };

    for (let i = 11; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);

      months.push(
        start.toLocaleString("en-US", { month: "short", year: "2-digit" })
      );

      counts.sellers.push(
        sellers.filter(
          (s) => s.createdAt >= start && s.createdAt < end
        ).length
      );

      counts.customers.push(
        customers.filter(
          (c) => c.createdAt >= start && c.createdAt < end
        ).length
      );

      const monthOrders = orders.filter(
        (o) => o.createdAt >= start && o.createdAt < end
      );

      counts.orders.push(monthOrders.length);

      counts.revenue.push(
        Math.round(
          monthOrders
            .filter((o) => o.paymentStatus === "PAID")
            .reduce((sum, o) => sum + o.totalAmount, 0)
        )
      );
    }

    const planDistribution = sellerPlans.map((row) => ({
      plan: row.activePlan ?? "FREE",
      count: row._count.id,
    }));

    const orderStatusBreakdown: Record<string, number> = {};
    for (const row of orderStatusCounts) {
      orderStatusBreakdown[row.status] = row._count.id;
    }

    const ticketStatusBreakdown: Record<string, number> = {};
    for (const row of ticketStatusCounts) {
      ticketStatusBreakdown[row.status] = row._count.id;
    }

    res.json({
      growth: {
        labels: months,
        datasets: [
          { label: "Sellers", data: counts.sellers },
          { label: "Customers", data: counts.customers },
          { label: "Orders", data: counts.orders },
          { label: "Revenue", data: counts.revenue },
        ],
      },
      planDistribution,
      orderStatusBreakdown,
      ticketStatusBreakdown,
    });
  } catch (err) {
    next(err);
  }
};
