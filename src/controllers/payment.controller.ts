import { Request, Response, NextFunction } from "express";
import prisma from "../prisma/client";
import { getSellerId } from "../services/seller.service";

// ─────────────────────────────────────────────
// GET /api/payments
// Returns payment transactions derived from orders
// Optional query: ?status=PAID|UNPAID|REFUNDED&from=ISO&to=ISO
// ─────────────────────────────────────────────
export const getPayments = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = await getSellerId(req);
    if (!sellerId) return res.status(401).json({ message: "Unauthorized" });

    const { status, from, to, search } = req.query as Record<string, string>;

    const where: any = { sellerId };
    if (status && status !== "all") {
      where.paymentStatus = status.toUpperCase();
    }
    if (from || to) {
      where.createdAt = {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(to) } : {}),
      };
    }
    if (search) {
      where.OR = [
        { customerName: { contains: search, mode: "insensitive" } },
        { customerPhone: { contains: search, mode: "insensitive" } },
        { customerEmail: { contains: search, mode: "insensitive" } },
        ...(isNaN(Number(search)) ? [] : [{ id: Number(search) }]),
      ];
    }

    const orders = await prisma.order.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        customerName: true,
        customerPhone: true,
        customerEmail: true,
        totalAmount: true,
        subtotal: true,
        tax: true,
        paymentStatus: true,
        paymentMethod: true,
        status: true,
        createdAt: true,
      },
    });

    // Map orders → payment transaction shape
    const transactions = orders.map((o) => ({
      id: `TXN-${String(o.id).padStart(5, "0")}`,
      orderId: o.id,
      customer: o.customerName,
      phone: o.customerPhone,
      email: o.customerEmail,
      amount: o.totalAmount,
      paymentStatus: o.paymentStatus, // PAID | UNPAID | REFUNDED
      orderStatus: o.status,
      method: o.paymentMethod || "—",
      type: o.paymentStatus === "REFUNDED" ? "debit" : "credit",
      createdAt: o.createdAt,
    }));

    res.json(transactions);
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// GET /api/payments/stats
// Summary stats for the payments dashboard
// ─────────────────────────────────────────────
export const getPaymentStats = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = await getSellerId(req);
    if (!sellerId) return res.status(401).json({ message: "Unauthorized" });

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

    const [
      totalCollected,
      thisMonthCollected,
      lastMonthCollected,
      unpaidAgg,
      refundedAgg,
      methodBreakdown,
    ] = await Promise.all([
      // All time collected
      prisma.order.aggregate({
        where: { sellerId, paymentStatus: "PAID" },
        _sum: { totalAmount: true },
        _count: { id: true },
      }),
      // This month
      prisma.order.aggregate({
        where: { sellerId, paymentStatus: "PAID", createdAt: { gte: startOfMonth } },
        _sum: { totalAmount: true },
      }),
      // Last month
      prisma.order.aggregate({
        where: {
          sellerId,
          paymentStatus: "PAID",
          createdAt: { gte: startOfLastMonth, lte: endOfLastMonth },
        },
        _sum: { totalAmount: true },
      }),
      // Unpaid (pending settlement)
      prisma.order.aggregate({
        where: { sellerId, paymentStatus: "UNPAID" },
        _sum: { totalAmount: true },
        _count: { id: true },
      }),
      // Refunded
      prisma.order.aggregate({
        where: { sellerId, paymentStatus: "REFUNDED" },
        _sum: { totalAmount: true },
        _count: { id: true },
      }),
      // Payment method breakdown
      prisma.order.groupBy({
        by: ["paymentMethod"],
        where: { sellerId, paymentStatus: "PAID" },
        _sum: { totalAmount: true },
        _count: { id: true },
      }),
    ]);

    const thisMonth = thisMonthCollected._sum.totalAmount ?? 0;
    const lastMonth = lastMonthCollected._sum.totalAmount ?? 0;
    const monthlyChange =
      lastMonth === 0
        ? 100
        : Math.round(((thisMonth - lastMonth) / lastMonth) * 100 * 10) / 10;

    res.json({
      totalCollected: totalCollected._sum.totalAmount ?? 0,
      totalTransactions: totalCollected._count.id,
      thisMonthCollected: thisMonth,
      monthlyChange,
      pendingSettlement: unpaidAgg._sum.totalAmount ?? 0,
      pendingCount: unpaidAgg._count.id,
      totalRefunded: refundedAgg._sum.totalAmount ?? 0,
      refundCount: refundedAgg._count.id,
      methodBreakdown: methodBreakdown.map((m) => ({
        method: m.paymentMethod || "Unknown",
        total: m._sum.totalAmount ?? 0,
        count: m._count.id,
      })),
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// GET /api/payments/export
// CSV export of all payments
// ─────────────────────────────────────────────
export const exportPayments = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = await getSellerId(req);
    if (!sellerId) return res.status(401).json({ message: "Unauthorized" });

    const orders = await prisma.order.findMany({
      where: { sellerId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        customerName: true,
        customerPhone: true,
        customerEmail: true,
        totalAmount: true,
        paymentStatus: true,
        paymentMethod: true,
        status: true,
        createdAt: true,
      },
    });

    let csv =
      "Transaction ID,Order ID,Date,Customer,Phone,Email,Amount,Payment Status,Payment Method,Order Status\n";

    for (const o of orders) {
      csv +=
        [
          `TXN-${String(o.id).padStart(5, "0")}`,
          o.id,
          new Date(o.createdAt).toLocaleDateString("en-IN"),
          `"${o.customerName}"`,
          o.customerPhone || "",
          o.customerEmail || "",
          o.totalAmount,
          o.paymentStatus,
          o.paymentMethod || "",
          o.status,
        ].join(",") + "\n";
    }

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=payments-export.csv"
    );
    return res.send(csv);
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// POST /api/payments/link
// Generate a Razorpay payment link
// Requires RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET in .env
// ─────────────────────────────────────────────
export const createPaymentLink = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = await getSellerId(req);
    if (!sellerId) return res.status(401).json({ message: "Unauthorized" });

    const { amount, customerName, customerPhone, customerEmail, description } =
      req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ message: "Valid amount is required" });
    }

    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (!keyId || !keySecret) {
      return res.status(503).json({
        message:
          "Payment gateway not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to your environment.",
      });
    }

    // Call Razorpay Payment Links API
    const credentials = Buffer.from(`${keyId}:${keySecret}`).toString("base64");

    const payload: any = {
      amount: Math.round(amount * 100), // paise
      currency: "INR",
      description: description || "Payment via Hypnate",
      reminder_enable: true,
      notify: {
        sms: !!customerPhone,
        email: !!customerEmail,
      },
      callback_url: process.env.FRONTEND_URL || "https://hypnate.in",
      callback_method: "get",
    };

    if (customerName || customerPhone || customerEmail) {
      payload.customer = {
        name: customerName || undefined,
        contact: customerPhone || undefined,
        email: customerEmail || undefined,
      };
    }

    const razorRes = await fetch("https://api.razorpay.com/v1/payment_links", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${credentials}`,
      },
      body: JSON.stringify(payload),
    });

    if (!razorRes.ok) {
      const errData = await razorRes.json();
      return res.status(502).json({
        message: errData?.error?.description || "Failed to create payment link",
      });
    }

    const data = await razorRes.json();

    res.status(201).json({
      paymentLinkId: data.id,
      shortUrl: data.short_url,
      amount: data.amount / 100,
      status: data.status,
    });
  } catch (err) {
    next(err);
  }
};