import { Request, Response, NextFunction } from "express";
import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";

/**
 * Resolve sellerId for current user
 */
const resolveSellerId = async (req: Request) => {
  const authReq = req as AuthRequest;

  let sellerId = authReq.user?.sellerId ?? undefined;

  if (!sellerId && authReq.user?.id) {
    const user = await prisma.user.findUnique({
      where: { id: authReq.user.id },
      select: { sellerId: true },
    });
    sellerId = user?.sellerId ?? undefined;
  }

  return sellerId;
};

/**
 * CREATE ORDER (with Customer auto-create / reuse)
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
         * 1️⃣ Find or create customer
         */
        const customer = await (prisma as any).customer.upsert({
          where: {
            sellerId_email: {
              sellerId,
              email: customerEmail ?? null,
            },
          },
          update: {
            name: customerName,
            phone: customerPhone ?? undefined,
            updatedAt: new Date(),
          },
          create: {
            sellerId,
            name: customerName,
            email: customerEmail ?? null,
            phone: customerPhone ?? null,
          },
        });

    /**
     * 2️⃣ Calculate order totals
     */
    const productIds = products.map((p: any) => p.productId);

    const dbProducts = await prisma.product.findMany({
      where: { id: { in: productIds }, sellerId },
    });

    let subtotal = 0;

    const productCreates = products.map((p: any) => {
      const prod = dbProducts.find((x) => x.id === p.productId);
      const price = prod?.price ?? 0;
      const quantity = Number(p.quantity || 1);

      subtotal += price * quantity;

      return {
        productId: p.productId,
        quantity,
        priceAtPurchase: price,
      };
    });

    const totalAmount = subtotal + Number(tax);

    /**
     * 3️⃣ Create order
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
          include: { Product: true },
        },
      },

    });

    /**
     * 4️⃣ Update customer analytics
     */
    await (prisma as any).customer.update({
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
export const getOrders = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await resolveSellerId(req);
    if (!sellerId) return res.status(401).json({ message: "Unauthorized" });

    const orders = await prisma.order.findMany({
      where: { sellerId },
      include: {
        products: {
          include: { Product: true },
        },
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
export const getOrderById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
      return res.status(400).json({ message: "Invalid order ID" });
    }

    const sellerId = await resolveSellerId(req);
    if (!sellerId) return res.status(401).json({ message: "Unauthorized" });

    const order = await prisma.order.findFirst({
      where: { id, sellerId },
      include: {
        products: {
          include: { Product: true },
        },
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
export const updateOrderStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    const { status, note } = req.body;
    if (Number.isNaN(id) || !status) {
      return res.status(400).json({ message: "Invalid request" });
    }

    const sellerId = await resolveSellerId(req);
    const order = await prisma.order.findFirst({ where: { id, sellerId } });
    if (!order) return res.status(404).json({ message: "Order not found" });

    const timeline = Array.isArray(order.timeline) ? order.timeline : [];
    timeline.unshift({
      status,
      timestamp: new Date().toISOString(),
      note: note ?? `Status updated to ${status}`,
    });

    const updated = await prisma.order.update({
      where: { id },
      data: { status, timeline },
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
};

/**
 * UPDATE PAYMENT STATUS
 */
export const updatePaymentStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    const { status, method, note } = req.body;

    if (Number.isNaN(id) || !status) {
      return res.status(400).json({ message: "Invalid request" });
    }

    const sellerId = await resolveSellerId(req);
    const order = await prisma.order.findFirst({ where: { id, sellerId } });
    if (!order) return res.status(404).json({ message: "Order not found" });

    const timeline = Array.isArray(order.timeline) ? order.timeline : [];
    timeline.unshift({
      status: `PAYMENT_${status}`,
      timestamp: new Date().toISOString(),
      note: note ?? `Payment updated to ${status}`,
    });

    const updated = await prisma.order.update({
      where: { id },
      data: {
        paymentStatus: status,
        paymentMethod: method ?? order.paymentMethod,
        timeline,
      },
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
};

/**
 * ADD TRACKING
 */
export const addTracking = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    const { trackingNumber, note } = req.body;

    if (Number.isNaN(id) || !trackingNumber) {
      return res.status(400).json({ message: "Invalid request" });
    }

    const sellerId = await resolveSellerId(req);
    const order = await prisma.order.findFirst({ where: { id, sellerId } });
    if (!order) return res.status(404).json({ message: "Order not found" });

    const timeline = Array.isArray(order.timeline) ? order.timeline : [];
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
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
};
