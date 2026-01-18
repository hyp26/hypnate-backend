import { Response, NextFunction } from "express";
import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";

export const exportOrders = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    // ✅ SAFE access
    const sellerId = req.user?.sellerId;

    if (!sellerId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const orders = await prisma.order.findMany({
      where: { sellerId },
      include: {
        products: {
          include: { Product: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    // Convert to CSV
    let csv =
      "Order ID,Date,Customer,Phone,Email,Status,Payment Status,Total,Items\n";

    for (const order of orders) {
      const items = order.products
        .map((p) => `${p.Product.name} (x${p.quantity})`)
        .join(" | ");

      csv += [
        order.id,
        order.createdAt.toISOString(),
        `"${order.customerName}"`,
        order.customerPhone || "",
        order.customerEmail || "",
        order.status,
        order.paymentStatus,
        order.totalAmount,
        `"${items}"`,
      ].join(",") + "\n";
    }

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=orders-export.csv"
    );

    return res.send(csv);
  } catch (err) {
    console.error("Export error:", err);
    next(err);
  }
};
