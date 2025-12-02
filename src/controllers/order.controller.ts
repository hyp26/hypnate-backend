// src/controllers/order.controller.ts
import { Request, Response, NextFunction } from "express";
import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";

/**
 * Helper: resolve sellerId for current user
 */
const resolveSellerId = async (req: AuthRequest) => {
  let sellerId = req.user?.sellerId ?? undefined;

  if (sellerId === null) sellerId = undefined;

  if (!sellerId) {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { sellerId: true }
    });

    if (user?.sellerId !== null && typeof user?.sellerId === "number") {
      return user.sellerId;
    }
  }

  return sellerId;
};


/**
 * Create Order
 * Body shape expected:
 * {
 *   customerName: string,
 *   customerPhone?: string,
 *   customerEmail?: string,
 *   shippingAddress?: string,
 *   paymentMethod?: string,
 *   products: [{ productId: number, quantity: number }],
 *   tax?: number (optional, or computed on server)
 * }
 */
export const createOrder = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { customerName, customerPhone, customerEmail, shippingAddress, paymentMethod, products: items, tax: taxInput } = req.body;
    const userId = req.user!.id;

    const sellerId = await resolveSellerId(req);
    if (!sellerId) return res.status(400).json({ message: "Seller account not found" });

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "Products are required" });
    }

    // Fetch product prices from DB to compute subtotal and to record priceAtPurchase
    const productIds = items.map((p: any) => p.productId);
    const productsFromDb = await prisma.product.findMany({
      where: { id: { in: productIds } }
    });

    // build product order create payload and compute subtotal
    let subtotal = 0;
    const productCreates = items.map((p: any) => {
      const prod = productsFromDb.find(dbp => dbp.id === p.productId);
      const price = prod ? prod.price : 0;
      const qty = Number(p.quantity || 1);
      subtotal += price * qty;
      return {
        productId: p.productId,
        quantity: qty,
        priceAtPurchase: price
      };
    });

    // Tax: use provided tax or default to 0 (you can adjust to compute GST % here)
    const tax = typeof taxInput === "number" ? taxInput : 0;
    const totalAmount = subtotal + tax;

    // initial timeline entry
    const initialTimeline = [
      {
        status: "PENDING",
        timestamp: new Date().toISOString(),
        note: "Order placed"
      }
    ];

    const order = await prisma.order.create({
      data: {
        customerName,
        customerPhone,
        customerEmail,
        shippingAddress,
        subtotal,
        tax,
        totalAmount,
        status: "PENDING",
        paymentStatus: "UNPAID",
        paymentMethod: paymentMethod || null,
        timeline: initialTimeline,
        sellerId,
        products: {
          create: productCreates
        }
      },
      include: {
        products: { include: { Product: true } }
      }
    });

    res.status(201).json(order);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/orders
 * Optionally filter by ?status=SHIPPED
 * Returns all orders for the current seller
 */
export const getOrders = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { status } = req.query;

    const sellerId = await resolveSellerId(req);
    if (!sellerId) return res.status(400).json({ message: "User has no seller profile" });

    const where: any = { sellerId };
    if (status) where.status = status as string;

    const orders = await prisma.order.findMany({
      where,
      include: {
        products: { include: { Product: true } }
      },
      orderBy: { createdAt: "desc" }
    });

    res.json(orders);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/orders/:id
 * Return detailed order for current seller
 */
export const getOrderById = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid order id" });

    const sellerId = await resolveSellerId(req);
    if (!sellerId) return res.status(400).json({ message: "Seller not found for user" });

    const order = await prisma.order.findFirst({
      where: { id, sellerId },
      include: {
        products: { include: { Product: true } }
      }
    });

    if (!order) return res.status(404).json({ message: "Order not found" });
    res.json(order);
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/orders/:id/status
 * Body: { status: string, note?: string }
 * Updates the order status and pushes a timeline entry.
 */
export const updateOrderStatus = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { status, note } = req.body;
    if (Number.isNaN(id) || !status) return res.status(400).json({ message: "Invalid request" });

    const sellerId = await resolveSellerId(req);
    if (!sellerId) return res.status(400).json({ message: "Seller not found for user" });

    // Fetch existing order (to preserve timeline and ensure ownership)
    const existing = await prisma.order.findFirst({ where: { id, sellerId } });
    if (!existing) return res.status(404).json({ message: "Order not found or unauthorized" });

    const existingTimeline = Array.isArray(existing.timeline) ? existing.timeline : [];
    const newEntry = { status, timestamp: new Date().toISOString(), note: note ?? `Status updated to ${status}` };
    const updatedTimeline = [newEntry, ...existingTimeline];

    const updated = await prisma.order.update({
      where: { id },
      data: {
        status,
        timeline: updatedTimeline
      },
      include: {
        products: { include: { Product: true } }
      }
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/orders/:id/payment
 * Body: { status: 'PAID'|'PENDING'|'REFUNDED', method?: string, note?: string }
 * Updates paymentStatus (and optionally paymentMethod) and pushes to timeline.
 */
export const updatePaymentStatus = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { status, method, note } = req.body;
    if (Number.isNaN(id) || !status) return res.status(400).json({ message: "Invalid request" });

    const sellerId = await resolveSellerId(req);
    if (!sellerId) return res.status(400).json({ message: "Seller not found for user" });

    const existing = await prisma.order.findFirst({ where: { id, sellerId } });
    if (!existing) return res.status(404).json({ message: "Order not found or unauthorized" });

    const existingTimeline = Array.isArray(existing.timeline) ? existing.timeline : [];
    const newEntry = { status: `PAYMENT_${status}`, timestamp: new Date().toISOString(), note: note ?? `Payment status changed to ${status}` };
    const updatedTimeline = [newEntry, ...existingTimeline];

    const updated = await prisma.order.update({
      where: { id },
      data: {
        paymentStatus: status,
        paymentMethod: method ?? existing.paymentMethod,
        timeline: updatedTimeline
      },
      include: {
        products: { include: { Product: true } }
      }
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/orders/:id/track
 * Body: { trackingNumber: string, note?: string }
 * Adds tracking number, sets status to SHIPPED and pushes timeline entry.
 */
export const addTracking = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { trackingNumber, note } = req.body;
    if (Number.isNaN(id) || !trackingNumber) return res.status(400).json({ message: "Invalid request" });

    const sellerId = await resolveSellerId(req);
    if (!sellerId) return res.status(400).json({ message: "Seller not found for user" });

    const existing = await prisma.order.findFirst({ where: { id, sellerId } });
    if (!existing) return res.status(404).json({ message: "Order not found or unauthorized" });

    const existingTimeline = Array.isArray(existing.timeline) ? existing.timeline : [];
    const newEntry = { status: "SHIPPED", timestamp: new Date().toISOString(), note: note ?? `Shipped. Tracking: ${trackingNumber}` };
    const updatedTimeline = [newEntry, ...existingTimeline];

    const updated = await prisma.order.update({
      where: { id },
      data: {
        trackingNumber,
        status: "SHIPPED",
        timeline: updatedTimeline
      },
      include: {
        products: { include: { Product: true } }
      }
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/orders/:id/status
 * Return only the status (kept for compatibility)
 */
export const getOrderStatus = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid order id" });

    const order = await prisma.order.findUnique({ where: { id }, select: { status: true } });
    if (!order) return res.status(404).json({ message: "Order not found" });
    res.json({ status: order.status });
  } catch (err) {
    next(err);
  }
};
