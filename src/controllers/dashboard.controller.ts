import { Request, Response, NextFunction } from "express";
import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";

const resolveSellerId = async (req: Request): Promise<number | undefined> => {
  const authReq = req as AuthRequest;
  if (authReq.user?.sellerId) return authReq.user.sellerId;
  if (authReq.user?.id) {
    const user = await prisma.user.findUnique({
      where: { id: authReq.user.id },
      select: { sellerId: true },
    });
    return user?.sellerId ?? undefined;
  }
  return undefined;
};

/**
 * GET /api/dashboard
 * Returns everything the dashboard needs in a single efficient query batch.
 */
export const getDashboard = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = await resolveSellerId(req);
    if (!sellerId) return res.status(401).json({ message: "Unauthorized" });

    const now = new Date();

    // ── Date boundaries ──────────────────────────────────────────────────
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    const todayEnd = new Date(now);
    todayEnd.setHours(23, 59, 59, 999);

    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);

    const yesterdayEnd = new Date(todayEnd);
    yesterdayEnd.setDate(yesterdayEnd.getDate() - 1);

    // Last 7 days for chart (start of day 6 days ago → now)
    const sevenDaysAgo = new Date(todayStart);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);

    // ── Run all queries in parallel ───────────────────────────────────────
    const [
      // Today stats
      todayRevenueAgg,
      todayOrderCount,
      yesterdayRevenueAgg,
      yesterdayOrderCount,

      // Totals
      totalCustomers,
      prevMonthCustomers,
      activeConversations,

      // Recent orders
      recentOrders,

      // Last 7 days orders for chart
      last7DaysOrders,

      // Top products (by quantity sold in last 30 days)
      topProducts,

      // Low stock alert count
      lowStockCount,

      // Order status breakdown
      orderStatusCounts,

      // Unread notifications
      unreadNotifications,
    ] = await Promise.all([
      // Today revenue
      prisma.order.aggregate({
        where: {
          sellerId,
          createdAt: { gte: todayStart, lte: todayEnd },
          paymentStatus: "PAID",
        },
        _sum: { totalAmount: true },
      }),

      // Today orders
      prisma.order.count({
        where: { sellerId, createdAt: { gte: todayStart, lte: todayEnd } },
      }),

      // Yesterday revenue (for % change)
      prisma.order.aggregate({
        where: {
          sellerId,
          createdAt: { gte: yesterdayStart, lte: yesterdayEnd },
          paymentStatus: "PAID",
        },
        _sum: { totalAmount: true },
      }),

      // Yesterday orders (for % change)
      prisma.order.count({
        where: { sellerId, createdAt: { gte: yesterdayStart, lte: yesterdayEnd } },
      }),

      // Total customers
      prisma.customer.count({ where: { sellerId } }),

      // Customers before this month (for % change)
      prisma.customer.count({
        where: {
          sellerId,
          createdAt: {
            lt: new Date(now.getFullYear(), now.getMonth(), 1),
          },
        },
      }),

      // Active (OPEN) conversations
      prisma.conversation.count({
        where: { sellerId, status: "OPEN" },
      }),

      // Recent 5 orders
      prisma.order.findMany({
        where: { sellerId },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          id: true,
          customerName: true,
          totalAmount: true,
          status: true,
          paymentStatus: true,
          createdAt: true,
          products: {
            take: 1,
            select: { product: { select: { name: true } } },
          },
        },
      }),

      // Last 7 days orders (for chart — grouped by day in JS)
      prisma.order.findMany({
        where: {
          sellerId,
          createdAt: { gte: sevenDaysAgo },
        },
        select: {
          totalAmount: true,
          paymentStatus: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      }),

      // Top products by quantity sold (last 30 days)
      prisma.productOrder.groupBy({
        by: ["productId"],
        where: {
          order: {
            sellerId,
            createdAt: {
              gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
            },
          },
        },
        _sum: { quantity: true },
        orderBy: { _sum: { quantity: "desc" } },
        take: 1,
      }),

      // Low stock count
      prisma.product.count({
        where: { sellerId, stock: { lte: 5 } },
      }),

      // Order status breakdown
      prisma.order.groupBy({
        by: ["status"],
        where: { sellerId },
        _count: { id: true },
      }),

      // Unread notifications
      prisma.notification.count({
        where: { sellerId, isRead: false },
      }),
    ]);

    // ── Resolve top product name ─────────────────────────────────────────
    let topProduct: { name: string; unitsSold: number } | null = null;
    if (topProducts.length > 0) {
      const tp = topProducts[0];
      const prod = await prisma.product.findUnique({
        where: { id: tp.productId },
        select: { name: true },
      });
      if (prod) {
        topProduct = { name: prod.name, unitsSold: tp._sum.quantity ?? 0 };
      }
    }

    // ── Compute % changes ────────────────────────────────────────────────
    const calcChange = (current: number, previous: number) => {
      if (previous === 0) return current > 0 ? 100 : 0;
      return Math.round(((current - previous) / previous) * 100 * 10) / 10;
    };

    const todayRev = todayRevenueAgg._sum.totalAmount ?? 0;
    const yestRev = yesterdayRevenueAgg._sum.totalAmount ?? 0;
    const newCustomersThisMonth = totalCustomers - prevMonthCustomers;

    // ── Build 7-day chart data ────────────────────────────────────────────
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const chartMap: Record<string, { revenue: number; orders: number }> = {};

    // Pre-fill last 7 days with zeros
    for (let i = 6; i >= 0; i--) {
      const d = new Date(todayStart);
      d.setDate(d.getDate() - i);
      const key = d.toDateString();
      chartMap[key] = { revenue: 0, orders: 0 };
    }

    for (const order of last7DaysOrders) {
      const key = new Date(order.createdAt).toDateString();
      if (chartMap[key]) {
        chartMap[key].orders += 1;
        if (order.paymentStatus === "PAID") {
          chartMap[key].revenue += order.totalAmount;
        }
      }
    }

    const chartData = Object.entries(chartMap).map(([dateStr, vals]) => ({
      day: dayNames[new Date(dateStr).getDay()],
      revenue: Math.round(vals.revenue),
      orders: vals.orders,
    }));

    // ── Order status breakdown map ────────────────────────────────────────
    const statusBreakdown: Record<string, number> = {};
    for (const row of orderStatusCounts) {
      statusBreakdown[row.status] = row._count.id;
    }

    // ── Response ─────────────────────────────────────────────────────────
    res.json({
      stats: {
        todayRevenue: Math.round(todayRev),
        revenueChange: calcChange(todayRev, yestRev),
        ordersToday: todayOrderCount,
        ordersChange: calcChange(todayOrderCount, yesterdayOrderCount),
        activeChats: activeConversations,
        totalCustomers,
        newCustomersThisMonth,
        lowStockCount,
        unreadNotifications,
      },
      recentOrders,
      chartData,
      topProduct,
      statusBreakdown,
      generatedAt: now.toISOString(),
    });
  } catch (err) {
    next(err);
  }
};