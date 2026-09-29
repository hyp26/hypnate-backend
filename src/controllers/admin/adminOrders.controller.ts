import { Request, Response, NextFunction } from "express";
import prisma from "../../prisma/client";
import { AdminAuthRequest } from "../../middleware/adminAuth.middleware";
import {
  listOrdersSchema,
  updateOrderStatusSchema,
} from "../../schemas/admin.schemas";
import { recordAudit } from "../../services/adminAudit.service";

/* ----------------------------------------------------
   HELPERS
---------------------------------------------------- */

const ORDER_INCLUDE = {
  seller: {
    select: { id: true, businessName: true },
  },
  customer: {
    select: { id: true, name: true, email: true, phone: true },
  },
  products: {
    select: {
      id: true,
      quantity: true,
      priceAtPurchase: true,
      product: {
        select: { id: true, name: true, imageUrl: true, price: true },
      },
    },
  },
} as const;

const serializeOrder = (order: {
  id: number;
  sellerId: number;
  seller: { id: number; businessName: string };
  customerId: number | null;
  customer: { id: number; name: string; email: string | null; phone: string | null } | null;
  customerName: string;
  customerPhone: string | null;
  customerEmail: string | null;
  shippingAddress: string | null;
  subtotal: number | null;
  tax: number | null;
  totalAmount: number;
  status: string;
  paymentStatus: string;
  paymentMethod: string | null;
  trackingNumber: string | null;
  createdAt: Date;
  products: {
    id: number;
    quantity: number;
    priceAtPurchase: number | null;
    product: { id: number; name: string; imageUrl: string | null; price: number };
  }[];
}) => {
  const items = order.products.map((item) => ({
    id: item.id,
    productId: item.product.id,
    productName: item.product.name,
    productImage: item.product.imageUrl ?? undefined,
    quantity: item.quantity,
    price: item.priceAtPurchase ?? item.product.price,
    total: (item.priceAtPurchase ?? item.product.price) * item.quantity,
  }));

  const itemTotal = items.reduce((sum, item) => sum + item.total, 0);

  let shippingAddress: Record<string, string> | undefined;

  if (order.shippingAddress) {
    try {
      shippingAddress = JSON.parse(order.shippingAddress);
    } catch {
      shippingAddress = undefined;
    }
  }

  return {
    id: String(order.id),
    orderNumber: `ORD-${String(order.id).padStart(6, "0")}`,
    sellerId: String(order.sellerId),
    seller: {
      id: order.seller.id,
      businessName: order.seller.businessName,
      email: "",
    },
    customerId: order.customerId !== null ? String(order.customerId) : "",
    customer: order.customer
      ? {
          id: order.customer.id,
          email: order.customer.email ?? "",
          name: order.customer.name,
        }
      : undefined,
    customerName: order.customerName,
    customerPhone: order.customerPhone ?? undefined,
    customerEmail: order.customerEmail ?? undefined,
    items,
    subtotal: order.subtotal ?? itemTotal,
    tax: order.tax ?? 0,
    discount: 0,
    total: order.totalAmount,
    currency: "INR",
    status: order.status,
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod ?? "",
    shippingAddress,
    trackingNumber: order.trackingNumber ?? undefined,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.createdAt.toISOString(),
  };
};

/* ----------------------------------------------------
   GET /api/admin/orders
---------------------------------------------------- */

export const listOrders = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const parsed = listOrdersSchema.safeParse(req);

    if (!parsed.success) {
      res.status(400).json({
        message: parsed.error.issues[0]?.message ?? "Invalid request",
      });
      return;
    }

    const {
      page,
      limit,
      search,
      status,
      paymentStatus,
      sellerId,
    } = parsed.data.query;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};

    if (status) {
      where.status = status;
    }

    if (paymentStatus) {
      where.paymentStatus = paymentStatus;
    }

    if (sellerId) {
      where.sellerId = sellerId;
    }

    if (search) {
      where.OR = [
        { customerName: { contains: search, mode: "insensitive" } },
        { customerEmail: { contains: search, mode: "insensitive" } },
        { customerPhone: { contains: search, mode: "insensitive" } },
        { id: Number(search) || -1 },
      ];
    }

    const [orders, total, statusCounts] = await Promise.all([
      prisma.order.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: ORDER_INCLUDE,
      }),
      prisma.order.count({ where }),
      prisma.order.groupBy({
        by: ["status"],
        _count: { id: true },
      }),
    ]);

    const statusBreakdown: Record<string, number> = {};
    for (const row of statusCounts) {
      statusBreakdown[row.status] = row._count.id;
    }

    res.json({
      data: orders.map(serializeOrder),
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      statusBreakdown,
    });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   GET /api/admin/orders/:id
---------------------------------------------------- */

export const getOrder = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ message: "Invalid order id" });
      return;
    }

    const order = await prisma.order.findUnique({
      where: { id },
      include: ORDER_INCLUDE,
    });

    if (!order) {
      res.status(404).json({ message: "Order not found" });
      return;
    }

    res.json({ order: serializeOrder(order) });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   PATCH /api/admin/orders/:id/status
---------------------------------------------------- */

export const updateOrderStatus = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ message: "Invalid order id" });
      return;
    }

    const parsed = updateOrderStatusSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        message: parsed.error.issues[0]?.message ?? "Invalid request",
      });
      return;
    }

    const order = await prisma.order.findUnique({
      where: { id },
      select: { id: true, status: true, sellerId: true },
    });

    if (!order) {
      res.status(404).json({ message: "Order not found" });
      return;
    }

    const updated = await prisma.order.update({
      where: { id },
      data: { status: parsed.data.status },
      include: ORDER_INCLUDE,
    });

    await recordAudit({
      actorId: req.adminUser!.id,
      action: "UPDATE",
      entityType: "Order",
      entityId: id,
      oldValue: { status: order.status },
      newValue: { status: updated.status },
      req,
    });

    res.json({ order: serializeOrder(updated) });
  } catch (err) {
    next(err);
  }
};
