import { Request, Response, NextFunction } from "express";
import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";

/**
 * Resolve sellerId for current user
 */
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
 * CREATE ORDER
 */
export const createOrder = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const authReq = req as AuthRequest;
    if (!authReq.user) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const sellerId = await resolveSellerId(req);
    if (!sellerId) {
      return res.status(400).json({ message: "Seller account not found" });
    }

    const {
      customerName,
      customerPhone,
      customerEmail,
      shippingAddress,
      paymentMethod,
      products,
      tax = 0,
    } = req.body;

    if (!customerName || !Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ message: "Invalid order payload" });
    }

    /**
     * Find or create customer
     */
    let customer;

    if (customerEmail) {
      customer = await prisma.customer.findUnique({
        where: {
          sellerId_email: {
            sellerId,
            email: customerEmail,
          },
        },
      });
    }

    if (!customer) {
      customer = await prisma.customer.create({
        data: {
          sellerId,
          name: customerName,
          email: customerEmail ?? null,
          phone: customerPhone ?? null,
        },
      });
    } else {
      await prisma.customer.update({
        where: { id: customer.id },
        data: {
          name: customerName,
          phone: customerPhone ?? customer.phone,
        },
      });
    }

    /**
     * Calculate totals
     */
    const productIds = products.map((p: any) => p.productId);

    const dbProducts = await prisma.product.findMany({
      where: {
        id: { in: productIds },
        sellerId,
      },
    });

    if (dbProducts.length !== productIds.length) {
      return res.status(400).json({ message: "Invalid product(s)" });
    }

    let subtotal = 0;

    const productCreates = products.map((p: any) => {
      const prod = dbProducts.find((x) => x.id === p.productId)!;
      const quantity = Number(p.quantity || 1);
      subtotal += prod.price * quantity;

      return {
        productId: prod.id,
        quantity,
        priceAtPurchase: prod.price,
      };
    });

    const totalAmount = subtotal + Number(tax);

    /**
     * Create order
     */
    const order = await prisma.order.create({
      data: {
        sellerId,
        customerId: customer.id,
        customerName,
        customerPhone,
        customerEmail,
        shippingAddress,
        subtotal,
        tax,
        totalAmount,
        paymentMethod: paymentMethod ?? null,
        status: "PENDING",
        paymentStatus: "UNPAID",
        timeline: [
          {
            status: "PENDING",
            timestamp: new Date().toISOString(),
            note: "Order placed",
          },
        ],
        products: {
          create: productCreates,
        },
      },
      include: {
        products: {
          include: { product: true }, // ✅ FIXED HERE
        },
        customer: true,
      },
    });

    /**
     * Update customer analytics
     */
    await prisma.customer.update({
      where: { id: customer.id },
      data: {
        totalOrders: { increment: 1 },
        totalSpent: { increment: totalAmount },
        lastOrderAt: new Date(),
      },
    });

    res.status(201).json(order);
  } catch (err) {
    next(err);
  }
};

/**
 * GET ALL ORDERS
 */
export const getOrders = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = await resolveSellerId(req);
    if (!sellerId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const orders = await prisma.order.findMany({
      where: { sellerId },
      include: {
        products: {
          include: { product: true }, // ✅ FIXED HERE
        },
        customer: true,
      },
      orderBy: { createdAt: "desc" },
    });

    res.json(orders);
  } catch (err) {
    next(err);
  }
};

/**
 * GET ORDER BY ID
 */
export const getOrderById = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
      return res.status(400).json({ message: "Invalid order ID" });
    }

    const sellerId = await resolveSellerId(req);
    if (!sellerId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const order = await prisma.order.findFirst({
      where: { id, sellerId },
      include: {
        products: {
          include: { product: true }, // ✅ FIXED HERE
        },
        customer: true,
      },
    });

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    res.json(order);
  } catch (err) {
    next(err);
  }
};

/**
 * UPDATE ORDER STATUS
 */
export const updateOrderStatus = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const id = Number(req.params.id);
    const { status, note } = req.body;

    if (Number.isNaN(id) || !status) {
      return res.status(400).json({ message: "Invalid request" });
    }

    const sellerId = await resolveSellerId(req);
    if (!sellerId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const existing = await prisma.order.findFirst({
      where: { id, sellerId },
    });

    if (!existing) {
      return res.status(404).json({ message: "Order not found" });
    }

    const timeline = Array.isArray(existing.timeline)
      ? existing.timeline
      : [];

    timeline.unshift({
      status,
      timestamp: new Date().toISOString(),
      note: note ?? `Status updated to ${status}`,
    });

    const updated = await prisma.order.update({
      where: { id },
      data: {
        status,
        timeline,
      },
      include: {
        products: {
          include: { product: true }, // ✅ correct relation
        },
        customer: true,
      },
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
};

/**
 * UPDATE PAYMENT STATUS
 */
export const updatePaymentStatus = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const id = Number(req.params.id);
    const { status, method, note } = req.body;

    if (Number.isNaN(id) || !status) {
      return res.status(400).json({ message: "Invalid request" });
    }

    const sellerId = await resolveSellerId(req);
    if (!sellerId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const existing = await prisma.order.findFirst({
      where: { id, sellerId },
    });

    if (!existing) {
      return res.status(404).json({ message: "Order not found" });
    }

    const timeline = Array.isArray(existing.timeline)
      ? existing.timeline
      : [];

    timeline.unshift({
      status: `PAYMENT_${status}`,
      timestamp: new Date().toISOString(),
      note: note ?? `Payment updated to ${status}`,
    });

    const updated = await prisma.order.update({
      where: { id },
      data: {
        paymentStatus: status,
        paymentMethod: method ?? existing.paymentMethod,
        timeline,
      },
      include: {
        products: {
          include: { product: true }, // ✅ correct relation
        },
        customer: true,
      },
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
};

/**
 * ADD TRACKING NUMBER
 */
export const addTracking = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const id = Number(req.params.id);
    const { trackingNumber, note } = req.body;

    if (Number.isNaN(id) || !trackingNumber) {
      return res.status(400).json({ message: "Invalid request" });
    }

    const sellerId = await resolveSellerId(req);
    if (!sellerId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const existing = await prisma.order.findFirst({
      where: { id, sellerId },
    });

    if (!existing) {
      return res.status(404).json({ message: "Order not found" });
    }

    const timeline = Array.isArray(existing.timeline)
      ? existing.timeline
      : [];

    timeline.unshift({
      status: "SHIPPED",
      timestamp: new Date().toISOString(),
      note: note ?? `Tracking added: ${trackingNumber}`,
    });

    const updated = await prisma.order.update({
      where: { id },
      data: {
        trackingNumber,
        status: "SHIPPED",
        timeline,
      },
      include: {
        products: {
          include: { product: true }, // ✅ correct relation
        },
        customer: true,
      },
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
};