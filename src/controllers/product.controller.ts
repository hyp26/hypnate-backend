import { Request, Response, NextFunction } from "express";
import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";
import { createNotification } from "./notification.controller";

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const LOW_STOCK_THRESHOLD = 10; // notify when stock falls below this

/**
 * CREATE PRODUCT
 */
export const createProduct = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const authReq = req as AuthRequest;

    if (!authReq.user) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const sellerId = authReq.user.sellerId;
    if (!sellerId) {
      return res.status(400).json({ message: "Seller account not found" });
    }

    const { name, description, category, price, stock, imageUrl } = req.body;

    if (!name || price === undefined) {
      return res.status(400).json({ message: "Invalid product data" });
    }

    const product = await prisma.product.create({
      data: {
        name,
        description: description ?? null,
        category: category ?? null,
        price: Number(price),
        stock: Number(stock ?? 0),
        imageUrl: imageUrl ?? null,
        sellerId,
      },
    });

    res.status(201).json(product);
  } catch (err) {
    next(err);
  }
};

/**
 * GET ALL PRODUCTS (PAGINATED)
 */
export const getAllProducts = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const authReq = req as AuthRequest;
    if (!authReq.user?.sellerId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const page = Math.max(Number(req.query.page) || DEFAULT_PAGE, 1);
    const limit = Math.max(Number(req.query.limit) || DEFAULT_LIMIT, 1);
    const search = (req.query.search as string) || "";
    const category = (req.query.category as string) || "";
    const sort = (req.query.sort as string) || "createdAt_desc";

    const where: any = { sellerId: authReq.user.sellerId };

    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
      ];
    }

    if (category) {
      where.category = category;
    }

    let orderBy: any = { createdAt: "desc" };
    if (sort === "price_asc") orderBy = { price: "asc" };
    if (sort === "price_desc") orderBy = { price: "desc" };
    if (sort === "stock_asc") orderBy = { stock: "asc" };
    if (sort === "stock_desc") orderBy = { stock: "desc" };
    if (sort === "createdAt_asc") orderBy = { createdAt: "asc" };

    const total = await prisma.product.count({ where });
    const products = await prisma.product.findMany({
      where,
      orderBy,
      skip: (page - 1) * limit,
      take: limit,
    });

    res.json({ products, total, page, limit });
  } catch (err) {
    next(err);
  }
};

/**
 * GET PRODUCT BY ID
 */
export const getProductById = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const authReq = req as AuthRequest;
    const id = Number(req.params.id);

    if (!authReq.user?.sellerId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (Number.isNaN(id)) {
      return res.status(400).json({ message: "Invalid product ID" });
    }

    const product = await prisma.product.findFirst({
      where: { id, sellerId: authReq.user.sellerId },
    });

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    res.json(product);
  } catch (err) {
    next(err);
  }
};

/**
 * UPDATE PRODUCT
 */
export const updateProduct = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const authReq = req as AuthRequest;
    const id = Number(req.params.id);

    if (!authReq.user?.sellerId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (Number.isNaN(id)) {
      return res.status(400).json({ message: "Invalid product ID" });
    }

    const updated = await prisma.product.updateMany({
      where: { id, sellerId: authReq.user.sellerId },
      data: req.body,
    });

    if (updated.count === 0) {
      return res.status(404).json({ message: "Product not found" });
    }

    const refreshed = await prisma.product.findUnique({ where: { id } });
    res.json(refreshed);
  } catch (err) {
    next(err);
  }
};

/**
 * UPDATE STOCK
 * ✅ createNotification lives here — fires when stock drops below threshold
 */
export const updateStock = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const authReq = req as AuthRequest;
    const id = Number(req.params.id);
    const stock = Number(req.body.stock);

    if (!authReq.user?.sellerId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const sellerId = authReq.user.sellerId;

    if (Number.isNaN(id) || Number.isNaN(stock)) {
      return res.status(400).json({ message: "Invalid payload" });
    }

    // Fetch product first so we have its name for the notification
    const product = await prisma.product.findFirst({
      where: { id, sellerId },
    });

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    await prisma.product.update({
      where: { id },
      data: { stock },
    });

    // ✅ Notify only when stock falls below threshold
    if (stock < LOW_STOCK_THRESHOLD) {
      await createNotification({
        sellerId,
        type: "STOCK_LOW",
        title: "Low Stock Alert",
        body: `${product.name} has only ${stock} unit${stock === 1 ? "" : "s"} left`,
        link: `/products/${product.id}`,
      });
    }

    res.json({ message: "Stock updated successfully" });
  } catch (err) {
    next(err);
  }
};

/**
 * GET LOW STOCK PRODUCTS
 */
export const getLowStockProducts = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const authReq = req as AuthRequest;

    if (!authReq.user?.sellerId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const products = await prisma.product.findMany({
      where: {
        sellerId: authReq.user.sellerId,
        stock: { lt: LOW_STOCK_THRESHOLD },
      },
      orderBy: { stock: "asc" },
    });

    res.json(products);
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE PRODUCT
 */
export const deleteProduct = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const authReq = req as AuthRequest;
    const id = Number(req.params.id);

    if (!authReq.user?.sellerId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    await prisma.product.deleteMany({
      where: { id, sellerId: authReq.user.sellerId },
    });

    res.json({ message: "Product deleted successfully" });
  } catch (err) {
    next(err);
  }
};