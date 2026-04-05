import { Request, Response, NextFunction } from "express";
import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";
import Papa from "papaparse";

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

// ─────────────────────────────────────────────
// GET /api/analytics/overview
// Full analytics dashboard data in one call
// Query: ?days=7|30|90
// ─────────────────────────────────────────────
export const getOverviewAnalytics = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = await resolveSellerId(req);
    if (!sellerId) return res.status(401).json({ message: "Unauthorized" });

    const days = Math.min(Number(req.query.days) || 7, 90);
    const now = new Date();

    const periodStart = new Date(now);
    periodStart.setDate(periodStart.getDate() - days);
    periodStart.setHours(0, 0, 0, 0);

    const prevPeriodStart = new Date(periodStart);
    prevPeriodStart.setDate(prevPeriodStart.getDate() - days);

    // ── Run all queries in parallel ───────────────────────────────────
    const [
      // Current period
      currentOrders,
      currentRevAgg,
      // Previous period (for % change)
      prevOrders,
      prevRevAgg,
      // All orders in period for chart
      ordersForChart,
      // Customer stats
      totalCustomers,
      newCustomers,
      prevNewCustomers,
      // Top products
      topProducts,
      // Conversation stats
      conversationStats,
      // Payment method breakdown
      paymentMethods,
      // Order status breakdown
      orderStatuses,
    ] = await Promise.all([
      // Current period order count
      prisma.order.count({
        where: { sellerId, createdAt: { gte: periodStart } },
      }),
      // Current period revenue (paid only)
      prisma.order.aggregate({
        where: { sellerId, paymentStatus: "PAID", createdAt: { gte: periodStart } },
        _sum: { totalAmount: true },
        _avg: { totalAmount: true },
      }),
      // Prev period orders
      prisma.order.count({
        where: { sellerId, createdAt: { gte: prevPeriodStart, lt: periodStart } },
      }),
      // Prev period revenue
      prisma.order.aggregate({
        where: { sellerId, paymentStatus: "PAID", createdAt: { gte: prevPeriodStart, lt: periodStart } },
        _sum: { totalAmount: true },
        _avg: { totalAmount: true },
      }),
      // All orders in current period with date for charting
      prisma.order.findMany({
        where: { sellerId, createdAt: { gte: periodStart } },
        select: {
          totalAmount: true,
          paymentStatus: true,
          createdAt: true,
          status: true,
        },
        orderBy: { createdAt: "asc" },
      }),
      // Total customers ever
      prisma.customer.count({ where: { sellerId } }),
      // New customers in period
      prisma.customer.count({
        where: { sellerId, createdAt: { gte: periodStart } },
      }),
      // New customers prev period
      prisma.customer.count({
        where: { sellerId, createdAt: { gte: prevPeriodStart, lt: periodStart } },
      }),
      // Top 5 products by revenue
      prisma.productOrder.groupBy({
        by: ["productId"],
        where: {
          order: {
            sellerId,
            createdAt: { gte: periodStart },
          },
        },
        _sum: { quantity: true, priceAtPurchase: true },
        orderBy: { _sum: { priceAtPurchase: "desc" } },
        take: 5,
      }),
      // Conversation stats
      prisma.conversation.groupBy({
        by: ["platform"],
        where: { sellerId, createdAt: { gte: periodStart } },
        _count: { id: true },
      }),
      // Payment method breakdown
      prisma.order.groupBy({
        by: ["paymentMethod"],
        where: { sellerId, paymentStatus: "PAID", createdAt: { gte: periodStart } },
        _sum: { totalAmount: true },
        _count: { id: true },
      }),
      // Order status breakdown
      prisma.order.groupBy({
        by: ["status"],
        where: { sellerId, createdAt: { gte: periodStart } },
        _count: { id: true },
      }),
    ]);

    // ── Resolve product names for top products ────────────────────────
    const productIds = topProducts.map(p => p.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true, imageUrl: true, category: true },
    });

    const topProductsResolved = topProducts.map(tp => {
      const prod = products.find(p => p.id === tp.productId);
      return {
        name: prod?.name || "Unknown",
        category: prod?.category || "",
        imageUrl: prod?.imageUrl || null,
        revenue: tp._sum.priceAtPurchase ?? 0,
        unitsSold: tp._sum.quantity ?? 0,
      };
    });

    // ── Build daily chart data ────────────────────────────────────────
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const chartMap: Record<string, { day: string; date: string; revenue: number; orders: number }> = {};

    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      const key = d.toDateString();
      const label = days <= 7 ? dayNames[d.getDay()] : `${d.getDate()}/${d.getMonth() + 1}`;
      chartMap[key] = { day: label, date: key, revenue: 0, orders: 0 };
    }

    for (const order of ordersForChart) {
      const key = new Date(order.createdAt).toDateString();
      if (chartMap[key]) {
        chartMap[key].orders += 1;
        if (order.paymentStatus === "PAID") {
          chartMap[key].revenue += order.totalAmount;
        }
      }
    }

    const chartData = Object.values(chartMap).map(d => ({
      ...d,
      revenue: Math.round(d.revenue),
    }));

    // ── % change helpers ──────────────────────────────────────────────
    const pct = (curr: number, prev: number) =>
      prev === 0 ? (curr > 0 ? 100 : 0) : Math.round(((curr - prev) / prev) * 100 * 10) / 10;

    const currentRevenue = currentRevAgg._sum.totalAmount ?? 0;
    const prevRevenue = prevRevAgg._sum.totalAmount ?? 0;
    const currentAOV = currentRevAgg._avg.totalAmount ?? 0;
    const prevAOV = prevRevAgg._avg.totalAmount ?? 0;

    // ── Channel data from conversations ───────────────────────────────
    const PLATFORM_COLORS: Record<string, string> = {
      WHATSAPP: "#25D366",
      INSTAGRAM: "#E1306C",
      FACEBOOK: "#1877F2",
      TELEGRAM: "#26A5E4",
    };

    const totalConvos = conversationStats.reduce((s, c) => s + c._count.id, 0);
    const channelData = conversationStats.map(c => ({
      name: c.platform.charAt(0) + c.platform.slice(1).toLowerCase(),
      value: totalConvos > 0 ? Math.round((c._count.id / totalConvos) * 100) : 0,
      count: c._count.id,
      color: PLATFORM_COLORS[c.platform] || "#94a3b8",
    }));

    // Fallback if no conversation data
    if (channelData.length === 0) {
      channelData.push(
        { name: "WhatsApp", value: 65, count: 0, color: "#25D366" },
        { name: "Instagram", value: 25, count: 0, color: "#E1306C" },
        { name: "Facebook", value: 10, count: 0, color: "#1877F2" },
      );
    }

    // ── Refund / return rate ──────────────────────────────────────────
    const refundedCount = await prisma.order.count({
      where: { sellerId, paymentStatus: "REFUNDED", createdAt: { gte: periodStart } },
    });
    const returnRate = currentOrders > 0
      ? Math.round((refundedCount / currentOrders) * 100 * 10) / 10
      : 0;

    // ── Conversation to order rate ────────────────────────────────────
    const convToOrderRate = totalConvos > 0
      ? Math.round((currentOrders / totalConvos) * 100 * 10) / 10
      : 0;

    res.json({
      period: { days, from: periodStart.toISOString(), to: now.toISOString() },
      kpis: {
        revenue: Math.round(currentRevenue),
        revenueChange: pct(currentRevenue, prevRevenue),
        orders: currentOrders,
        ordersChange: pct(currentOrders, prevOrders),
        aov: Math.round(currentAOV),
        aovChange: pct(currentAOV, prevAOV),
        customers: totalCustomers,
        newCustomers,
        newCustomersChange: pct(newCustomers, prevNewCustomers),
        convToOrderRate,
        returnRate,
      },
      chartData,
      channelData,
      topProducts: topProductsResolved,
      paymentMethods: paymentMethods.map(m => ({
        method: m.paymentMethod || "Unknown",
        revenue: m._sum.totalAmount ?? 0,
        count: m._count.id,
      })),
      orderStatuses: orderStatuses.map(s => ({
        status: s.status,
        count: s._count.id,
      })),
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// GET /api/analytics/export
// Download analytics report as CSV
// ─────────────────────────────────────────────
export const exportAnalytics = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = await resolveSellerId(req);
    if (!sellerId) return res.status(401).json({ message: "Unauthorized" });

    const days = Math.min(Number(req.query.days) || 30, 90);
    const periodStart = new Date();
    periodStart.setDate(periodStart.getDate() - days);

    const orders = await prisma.order.findMany({
      where: { sellerId, createdAt: { gte: periodStart } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        createdAt: true,
        customerName: true,
        totalAmount: true,
        status: true,
        paymentStatus: true,
        paymentMethod: true,
      },
    });

    const csvData = orders.map(o => ({
      Date: new Date(o.createdAt).toLocaleDateString("en-IN"),
      "Order ID": o.id,
      Customer: o.customerName,
      Total: o.totalAmount,
      "Order Status": o.status,
      "Payment Status": o.paymentStatus,
      "Payment Method": o.paymentMethod || "",
    }));

    const csv = Papa.unparse(csvData);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename=analytics-${days}days.csv`);
    return res.send(csv);
  } catch (err) {
    next(err);
  }
};