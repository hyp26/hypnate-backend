import { Request, Response, NextFunction } from "express";
import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";

/**
 * Resolve sellerId from authenticated user
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
 * GET /api/customers
 * List all customers for seller
 */
export const getCustomers = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = await resolveSellerId(req);
    if (!sellerId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { search } = req.query;

    const customers = await prisma.customer.findMany({
      where: {
        sellerId,
        ...(search
          ? {
              OR: [
                { name: { contains: String(search), mode: "insensitive" } },
                { email: { contains: String(search), mode: "insensitive" } },
                { phone: { contains: String(search), mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: "desc" },
    });

    res.json(customers);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/customers/:id
 * Get single customer with stats
 */
export const getCustomerById = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = await resolveSellerId(req);
    if (!sellerId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
      return res.status(400).json({ message: "Invalid customer ID" });
    }

    const customer = await prisma.customer.findFirst({
      where: { id, sellerId },
      include: {
        orders: {
          orderBy: { createdAt: "desc" },
          include: {
            products: { include: { Product: true } },
          },
        },
      },
    });

    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    res.json(customer);
  } catch (err) {
    next(err);
  }
};

/**
 * UPDATE /api/customers/:id
 */
export const updateCustomer = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = await resolveSellerId(req);
    if (!sellerId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
      return res.status(400).json({ message: "Invalid customer ID" });
    }

    const { name, email, phone } = req.body;

    const existing = await prisma.customer.findFirst({
      where: { id, sellerId },
    });

    if (!existing) {
      return res.status(404).json({ message: "Customer not found" });
    }

    const updated = await prisma.customer.update({
      where: { id },
      data: {
        name: name ?? existing.name,
        email: email ?? existing.email,
        phone: phone ?? existing.phone,
      },
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/customers/:id
 * (Soft delete recommended later — hard delete for now)
 */
export const deleteCustomer = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = await resolveSellerId(req);
    if (!sellerId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
      return res.status(400).json({ message: "Invalid customer ID" });
    }

    const customer = await prisma.customer.findFirst({
      where: { id, sellerId },
    });

    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    await prisma.customer.delete({ where: { id } });

    res.json({ message: "Customer deleted successfully" });
  } catch (err) {
    next(err);
  }
};
