import { Request, Response, NextFunction } from "express";
import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";
import { getSellerIdForReq } from "../utils/user";

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;

export const createProduct = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerIdForReq(req);
    if (!sellerId) return res.status(400).json({ message: "Seller account not found" });

    const body = req.body || {};
    const createData: any = {
      name: body.name,
      description: body.description ?? null,
      category: body.category ?? null,
      price: body.price !== undefined ? Number(body.price) : undefined,
      stock: body.stock !== undefined ? Number(body.stock) : 0,
      imageUrl: body.imageUrl ?? body.image ?? null,
      sellerId,
    };

    if (!createData.name || createData.price === undefined || Number.isNaN(createData.price)) {
      return res.status(400).json({ message: "Invalid product data" });
    }

    Object.keys(createData).forEach((k) => createData[k] === undefined && delete createData[k]);

    const product = await prisma.product.create({ data: createData });
    return res.status(201).json(product);
  } catch (err: any) {
    console.error("createProduct error:", err);
    if (err.code === "P2002") {
      return res.status(409).json({ message: "Unique constraint failed", target: err.meta?.target });
    }
    return next(err);
  }
};

export const getAllProducts = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerIdForReq(req);
    if (!sellerId) return res.status(404).json({ message: "Seller profile not found" });

    // Query params
    const page = Math.max(Number(req.query.page) || DEFAULT_PAGE, 1);
    const limit = Math.max(Number(req.query.limit) || DEFAULT_LIMIT, 1);
    const search = (req.query.search as string) || "";
    const category = (req.query.category as string) || "";
    const sort = (req.query.sort as string) || "createdAt_desc"; // createdAt_desc | price_asc | price_desc | stock_asc | stock_desc

    const where: any = { sellerId };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
      ];
    }
    if (category) {
      where.category = { equals: category };
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

    return res.json({ products, total, page, limit });
  } catch (err) {
    console.error("getAllProducts error:", err);
    return next(err);
  }
};

export const getProductById = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid product ID" });

    const sellerId = await getSellerIdForReq(req);
    if (!sellerId) return res.status(404).json({ message: "Seller profile not found" });

    const product = await prisma.product.findFirst({ where: { id, sellerId } });
    if (!product) return res.status(404).json({ message: "Product not found" });

    return res.json(product);
  } catch (err) {
    console.error("getProductById error:", err);
    return next(err);
  }
};

export const updateProduct = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid product ID" });

    const sellerId = await getSellerIdForReq(req);
    if (!sellerId) return res.status(404).json({ message: "Seller profile not found" });

    const body = req.body || {};
    const updateData: any = {
      name: body.name,
      description: body.description ?? null,
      category: body.category ?? null,
      price: body.price !== undefined ? Number(body.price) : undefined,
      stock: body.stock !== undefined ? Number(body.stock) : undefined,
      imageUrl: body.imageUrl ?? body.image ?? undefined,
    };

    Object.keys(updateData).forEach((k) => updateData[k] === undefined && delete updateData[k]);

    const updated = await prisma.product.updateMany({
      where: { id, sellerId },
      data: updateData,
    });

    if (updated.count === 0) return res.status(404).json({ message: "Product not found or unauthorized" });

    const refreshed = await prisma.product.findUnique({ where: { id } });
    return res.json(refreshed);
  } catch (err) {
    console.error("updateProduct error:", err);
    return next(err);
  }
};

export const updateStock = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    const stock = Number(req.body.stock);
    if (Number.isNaN(id) || Number.isNaN(stock)) return res.status(400).json({ message: "Invalid stock update payload" });

    const sellerId = await getSellerIdForReq(req);
    if (!sellerId) return res.status(404).json({ message: "Seller profile not found" });

    const updated = await prisma.product.updateMany({
      where: { id, sellerId },
      data: { stock },
    });

    if (updated.count === 0) return res.status(404).json({ message: "Product not found or unauthorized" });

    return res.json({ message: "Stock updated successfully" });
  } catch (err) {
    console.error("updateStock error:", err);
    return next(err);
  }
};

export const getLowStockProducts = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerIdForReq(req);
    if (!sellerId) return res.status(404).json({ message: "Seller profile not found" });

    const products = await prisma.product.findMany({
      where: { sellerId, stock: { lt: 10 } },
      orderBy: { stock: "asc" },
    });

    return res.json(products);
  } catch (err) {
    console.error("getLowStockProducts error:", err);
    return next(err);
  }
};

export const deleteProduct = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid product ID" });

    const sellerId = await getSellerIdForReq(req);
    if (!sellerId) return res.status(404).json({ message: "Seller profile not found" });

    const deleted = await prisma.product.deleteMany({ where: { id, sellerId } });
    if (deleted.count === 0) return res.status(404).json({ message: "Product not found or unauthorized" });

    return res.json({ message: "Product deleted successfully" });
  } catch (err) {
    console.error("deleteProduct error:", err);
    return next(err);
  }
};
