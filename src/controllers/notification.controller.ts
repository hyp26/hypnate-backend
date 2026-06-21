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
