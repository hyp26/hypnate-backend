import { Request, Response, NextFunction } from "express";
import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";
import { getSellerId } from "../services/seller.service";

export const globalSearch = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = await getSellerId(req as AuthRequest);
    if (!sellerId) return res.status(401).json({ message: "Unauthorized" });

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q || q.length < 2) {
      return res.json({ orders: [], customers: [], products: [] });
    }

    const [orders, customers, products] = await Promise.all([
      prisma.order.findMany({
        where: {
          sellerId,
          OR: [
            { customerName: { contains: q, mode: "insensitive" } },
            { customerPhone: { contains: q, mode: "insensitive" } },
            { status: { contains: q, mode: "insensitive" } },
            // Search by order ID if q is numeric
            ...(isNaN(Number(q)) ? [] : [{ id: Number(q) }]),
          ],
        },
        take: 5,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          customerName: true,
          totalAmount: true,
          status: true,
          createdAt: true,
        },
      }),

      prisma.customer.findMany({
        where: {
          sellerId,
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
            { phone: { contains: q, mode: "insensitive" } },
          ],
        },
        take: 5,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          totalOrders: true,
        },
      }),

      prisma.product.findMany({
        where: {
          sellerId,
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { category: { contains: q, mode: "insensitive" } },
            { description: { contains: q, mode: "insensitive" } },
          ],
        },
        take: 5,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          price: true,
          stock: true,
          imageUrl: true,
          category: true,
        },
      }),
    ]);

    res.json({ orders, customers, products });
  } catch (err) {
    next(err);
  }
};