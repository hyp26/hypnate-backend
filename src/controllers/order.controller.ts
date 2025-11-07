import { Request, Response, NextFunction } from "express";
import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";

// CREATE order (optional — for internal tests)
export const createOrder = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { customer, products } = req.body; // products = [{ productId, quantity }]
    const userId = req.user!.id;

    // fetch sellerId linked to this user
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { sellerId: true },
    });

    if (!user?.sellerId) {
      return res.status(400).json({ message: "Seller account not found" });
    }

    const sellerId = user.sellerId;

    // calculate total amount
    const totalAmount = await products.reduce(async (sumPromise: any, p: any) => {
      const sum = await sumPromise;
      const product = await prisma.product.findUnique({
        where: { id: p.productId },
      });
      return sum + (product?.price || 0) * p.quantity;
    }, Promise.resolve(0));

    const order = await prisma.order.create({
      data: {
        customer,
        totalAmount,
        status: "PENDING",
        sellerId, // ✅ now matches Seller table
        products: {
          create: products.map((p: any) => ({
            productId: p.productId,
            quantity: p.quantity,
          })),
        },
      },
      include: { products: { include: { Product: true } } },
    });

    res.status(201).json(order);
  } catch (err) {
    next(err);
  }
};

// GET all orders for this seller
export const getOrders = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { status } = req.query;

    // find the user so we can read sellerId
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) return res.status(404).json({ message: "User not found" });
    if (!user.sellerId) return res.status(400).json({ message: "User has no seller profile" });

    const where: any = { sellerId: user.sellerId };
    if (status) where.status = status as string;

    const orders = await prisma.order.findMany({
      where,
      include: {
        products: { include: { Product: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json(orders);
  } catch (err) {
    next(err);
  }
};


// GET single order details
export const getOrderById = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id);

    // ✅ get the sellerId either from token or via user lookup
    const sellerId = req.user?.sellerId;

    // fallback: fetch from DB if not embedded in JWT
    let resolvedSellerId = sellerId;
    if (!resolvedSellerId) {
      const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
      if (!user?.sellerId)
        return res.status(400).json({ message: "Seller not found for user" });
      resolvedSellerId = user.sellerId;
    }

    const order = await prisma.order.findFirst({
      where: { id, sellerId: resolvedSellerId },
      include: {
        products: { include: { Product: true } },
      },
    });

    if (!order) return res.status(404).json({ message: "Order not found" });

    res.json(order);
  } catch (err) {
    next(err);
  }
};

// UPDATE order status
export const updateOrderStatus = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id);
    const { status } = req.body;

    // Resolve sellerId (prefer from token)
    let sellerId = req.user?.sellerId;
    if (!sellerId) {
      const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
      if (!user?.sellerId) {
        return res.status(400).json({ message: "Seller not found for user" });
      }
      sellerId = user.sellerId;
    }

    // Update order scoped to seller
    const updated = await prisma.order.updateMany({
      where: { id, sellerId },
      data: { status },
    });

    if (updated.count === 0) {
      return res.status(404).json({ message: "Order not found or unauthorized" });
    }

    res.json({ message: "Order status updated successfully" });
  } catch (err) {
    next(err);
  }
};

// get order status
export const getOrderStatus = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id);
    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }
    res.json({ status: order.status });
  } catch (err) {
    next(err);
  }
};
