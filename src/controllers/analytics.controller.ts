// src/controllers/analytics.controller.ts
import { Response, NextFunction } from "express";
import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";

type RevenueGroup = {
  createdAt: Date;
  _sum: { totalAmount: number | null };
};

export const getOverviewAnalytics = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const sellerId = req.user!.id;

    // 1. Total sales (sum of all delivered orders)
    const totalSalesResult = await prisma.order.aggregate({
      where: { sellerId, status: "DELIVERED" },
      _sum: { totalAmount: true },
    });

    const totalSales = totalSalesResult._sum.totalAmount || 0;

    // 2. Total orders
    const totalOrders = await prisma.order.count({ where: { sellerId } });

    // 3. Top product (by quantity sold)
    const topProduct = await prisma.productOrder.groupBy({
      by: ["productId"],
      where: {
        Order: { sellerId, status: "DELIVERED" },
      },
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: "desc" } },
      take: 1,
    });

    let topProductName: string | null = null;
    if (topProduct.length) {
      const product = await prisma.product.findUnique({ where: { id: topProduct[0].productId } });
      topProductName = product?.name ?? null;
    }

    // 4. Revenue trend (last 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Use groupBy on date-level; Prisma may return createdAt as Date
    const recentRevenue = await prisma.order.groupBy({
      by: ["createdAt"],
      where: {
        sellerId,
        status: "DELIVERED",
        createdAt: {
          gte: sevenDaysAgo,
        },
      },
      _sum: { totalAmount: true },
    });

    // Explicitly type the map parameter to avoid implicit any
    const revenueByDay = (recentRevenue as RevenueGroup[]).map((r) => ({
      date: r.createdAt.toISOString().split("T")[0],
      revenue: r._sum.totalAmount || 0,
    }));

    res.json({
      totalSales,
      totalOrders,
      topProduct: topProductName,
      revenueByDay,
    });
  } catch (err) {
    next(err);
  }
};
