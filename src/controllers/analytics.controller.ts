import { Request, Response, NextFunction } from "express";
import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";

export const getOverviewAnalytics = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const authReq = req as AuthRequest;

    if (!authReq.user?.sellerId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const sellerId = authReq.user.sellerId;

    // example analytics logic
    const totalOrders = await prisma.order.count({ where: { sellerId } });
    const totalRevenue = await prisma.order.aggregate({
      where: { sellerId, paymentStatus: "PAID" },
      _sum: { totalAmount: true },
    });

    res.json({
      totalOrders,
      totalRevenue: totalRevenue._sum.totalAmount ?? 0,
    });
  } catch (err) {
    next(err);
  }
};
