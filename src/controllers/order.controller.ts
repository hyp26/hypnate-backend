import { Request, Response, NextFunction } from "express";
import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";
import { createNotification } from "../services/notification.service";
import { getSellerId } from "../services/seller.service";

const LOW_STOCK_THRESHOLD = 10;

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

    const sellerId = await getSellerId(req as AuthRequest);
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

    if (Number(tax) < 0) {
      return res.status(400).json({ message: "Tax cannot be negative" });
    }

    /**
     * Merge duplicate line items so the same productId appearing more than
     * once in the payload is validated and decremented as a single combined
     * quantity, not as separate smaller (individually valid) quantities.
     */
    const productQuantityMap = new Map<number, number>();
    for (const item of products) {
      const productId = Number(item.productId);

      if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).json({ message: "Invalid product ID" });
      }

      const current = productQuantityMap.get(productId) || 0;
      productQuantityMap.set(
        productId,
        current + Number(item.quantity || 1)
      );
    }

    /**
     * Validate products exist and belong to this seller
     */
    const productIds = [...productQuantityMap.keys()];

    const dbProducts = await prisma.product.findMany({
      where: {
        id: { in: productIds },
        sellerId,
      },
    });

    if (dbProducts.length !== productIds.length) {
      return res.status(400).json({ message: "Invalid product(s)" });
    }

    for (const [productId, totalQuantity] of productQuantityMap) {
      const product = dbProducts.find((p) => p.id === productId);

      if (!product) continue;

      if (totalQuantity <= 0) {
        return res.status(400).json({
          message: "Quantity must be greater than 0",
        });
      }

      if (product.stock < totalQuantity) {
        return res.status(400).json({
          message: `${product.name} has only ${product.stock} units available`,
        });
      }
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

    if (totalAmount <= 0) {
      return res.status(400).json({
        message: "Order total must be greater than 0",
      });
    }

    // Collected inside the transaction, used for notifications after commit
    const lowStockProducts: { id: number; name: string; stock: number }[] = [];

    const order = await prisma.$transaction(async (tx) => {
      let customer;

      if (customerEmail) {
        customer = await tx.customer.findUnique({
          where: {
            sellerId_email: {
              sellerId,
              email: customerEmail,
            },
          },
        });
      }

      if (!customer) {
        customer = await tx.customer.create({
          data: {
            sellerId,
            name: customerName,
            email: customerEmail ?? null,
            phone: customerPhone ?? null,
          },
        });
      } else {
        customer = await tx.customer.update({
          where: {
            id: customer.id,
          },
          data: {
            name: customerName,
            phone: customerPhone ?? customer.phone,
          },
        });
      }

      const createdOrder = await tx.order.create({
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
            include: {
              product: true,
            },
          },
          customer: true,
        },
      });

      // Decrement stock atomically for each distinct product. updateMany's
      // `gte` guard means the decrement only applies if enough stock is
      // still available at the moment of the write — this closes the
      // race window between the earlier read-based validation and the
      // actual write, preventing concurrent requests from overselling.
      for (const [productId, quantity] of productQuantityMap) {
        const before = dbProducts.find((p) => p.id === productId)!;

        const result = await tx.product.updateMany({
          where: {
            id: productId,
            stock: { gte: quantity },
          },
          data: {
            stock: { decrement: quantity },
          },
        });

        if (result.count === 0) {
          throw new Error(`Insufficient stock for "${before.name}"`);
        }

        const updatedProduct = await tx.product.findUniqueOrThrow({
          where: { id: productId },
          select: { id: true, name: true, stock: true },
        });

        // Only notify the first time stock crosses below the threshold,
        // not on every subsequent order that keeps it low — avoids
        // spamming the seller with repeat low-stock alerts.
        if (
          updatedProduct.stock < LOW_STOCK_THRESHOLD &&
          before.stock >= LOW_STOCK_THRESHOLD
        ) {
          lowStockProducts.push(updatedProduct);
        }
      }

      await tx.customer.update({
        where: {
          id: customer.id,
        },
        data: {
          totalOrders: {
            increment: 1,
          },
          totalSpent: {
            increment: totalAmount,
          },
          lastOrderAt: new Date(),
        },
      });

      return createdOrder;
    });

    // Fire notifications after the transaction has committed.
    // Wrapped so a notification-service failure never surfaces as an order
    // failure — the order is already committed at this point.
    for (const product of lowStockProducts) {
      try {
        await createNotification({
          sellerId,
          type: "STOCK_LOW",
          title: "Low Stock Alert",
          body: `${product.name} has only ${product.stock} units left`,
          link: `/products/${product.id}`,
        });
      } catch (notifyErr) {
        console.error("Low stock notification failed:", notifyErr);
      }
    }

    try {
      await createNotification({
        sellerId,
        type: "ORDER_NEW",
        title: `New Order #${order.id}`,
        body: `${customerName} placed an order for ₹${totalAmount}`,
        link: `/orders/${order.id}`,
      });
    } catch (notifyErr) {
      console.error("New order notification failed:", notifyErr);
    }

    res.status(201).json(order);
  } catch (err: any) {
    if (err instanceof Error && err.message.startsWith("Insufficient stock")) {
      return res.status(409).json({ message: err.message });
    }
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
    const sellerId = await getSellerId(req as AuthRequest);
    if (!sellerId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const orders = await prisma.order.findMany({
      where: { sellerId },
      include: {
        products: {
          include: { product: true },
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

    const sellerId = await getSellerId(req as AuthRequest);
    if (!sellerId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const order = await prisma.order.findFirst({
      where: { id, sellerId },
      include: {
        products: {
          include: { product: true },
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

    const sellerId = await getSellerId(req as AuthRequest);
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
          include: { product: true },
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

    const sellerId = await getSellerId(req as AuthRequest);
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
          include: { product: true },
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

    const sellerId = await getSellerId(req as AuthRequest);
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
          include: { product: true },
        },
        customer: true,
      },
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
};