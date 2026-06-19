import { Request, Response, NextFunction } from "express";
import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";
import { getSellerId } from "../services/seller.service";

// ─────────────────────────────────────────────
// GET /api/notifications
// Returns latest 30 notifications + unread count
// ─────────────────────────────────────────────

export const getNotifications = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = await getSellerId(req as AuthRequest);
    if (!sellerId) return res.status(401).json({ message: "Unauthorized" });

    const [notifications, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: { sellerId },
        orderBy: { createdAt: "desc" },
        take: 30,
      }),
      prisma.notification.count({
        where: { sellerId, isRead: false },
      }),
    ]);

    res.json({ notifications, unreadCount });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// PATCH /api/notifications/:id/read
// Mark single notification as read
// ─────────────────────────────────────────────

export const markOneRead = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = await getSellerId(req as AuthRequest);
    if (!sellerId) return res.status(401).json({ message: "Unauthorized" });

    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid ID" });

    const existing = await prisma.notification.findFirst({
      where: { id, sellerId },
    });
    if (!existing) return res.status(404).json({ message: "Not found" });

    await prisma.notification.update({ where: { id }, data: { isRead: true } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// PATCH /api/notifications/read-all
// Mark ALL notifications as read for seller
// ─────────────────────────────────────────────

export const markAllRead = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = await getSellerId(req as AuthRequest);
    if (!sellerId) return res.status(401).json({ message: "Unauthorized" });

    await prisma.notification.updateMany({
      where: { sellerId, isRead: false },
      data: { isRead: true },
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// DELETE /api/notifications/:id
// Delete a single notification
// ─────────────────────────────────────────────

export const deleteNotification = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = await getSellerId(req as AuthRequest);
    if (!sellerId) return res.status(401).json({ message: "Unauthorized" });

    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid ID" });

    const existing = await prisma.notification.findFirst({
      where: { id, sellerId },
    });
    if (!existing) return res.status(404).json({ message: "Not found" });

    await prisma.notification.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};


// ─────────────────────────────────────────────
// GET /api/search?q=...
// Global search across Orders, Customers, Products
// ─────────────────────────────────────────────

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