import { Request, Response, NextFunction } from "express";
import prisma from "../../prisma/client";
import { AdminAuthRequest } from "../../middleware/adminAuth.middleware";
import { listCustomersSchema } from "../../schemas/admin.schemas";

/* ----------------------------------------------------
   GET /api/admin/customers
---------------------------------------------------- */

export const listCustomers = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const parsed = listCustomersSchema.safeParse(req);

    if (!parsed.success) {
      res.status(400).json({
        message: parsed.error.issues[0]?.message ?? "Invalid request",
      });
      return;
    }

    const { page, limit, search, sellerId } = parsed.data.query;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};

    if (sellerId) {
      where.sellerId = sellerId;
    }

    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
        { phone: { contains: search, mode: "insensitive" } },
      ];
    }

    const [customers, total] = await Promise.all([
      prisma.customer.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          totalOrders: true,
          totalSpent: true,
          lastOrderAt: true,
          createdAt: true,
          updatedAt: true,
          seller: {
            select: { id: true, businessName: true },
          },
        },
      }),
      prisma.customer.count({ where }),
    ]);

    const data = customers.map((customer) => {
      const nameParts = customer.name.trim().split(/\s+/);

      return {
        id: customer.id,
        email: customer.email ?? "",
        firstName: nameParts[0] ?? "",
        lastName: nameParts.slice(1).join(" "),
        status: "ACTIVE",
        phone: customer.phone ?? undefined,
        sellerId: customer.seller.id,
        sellerBusinessName: customer.seller.businessName,
        totalOrders: customer.totalOrders,
        totalSpent: customer.totalSpent,
        lastOrderAt: customer.lastOrderAt?.toISOString() ?? undefined,
        createdAt: customer.createdAt.toISOString(),
        updatedAt: customer.updatedAt.toISOString(),
      };
    });

    res.json({
      data,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    next(err);
  }
};
