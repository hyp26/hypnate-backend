import { Request, Response, NextFunction } from "express";
import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";
import { getSellerIdForReq } from "../utils/user";

// CREATE PRODUCT (JSON ONLY)
// Frontend uploads image separately and sends an image URL in `image` or `imageUrl`.
export const createProduct = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerIdForReq(req);
    if (!sellerId) {
      return res.status(400).json({ message: "Seller account not found" });
    }

    // Accept both `image` and `imageUrl` from frontend, map to imageUrl
    const body = req.body || {};
    const name = (body.name || "").trim();
    const description = body.description ?? null;
    const price = body.price !== undefined ? Number(body.price) : undefined;
    const stock = body.stock !== undefined ? Number(body.stock) : undefined;
    const imageUrl = body.imageUrl ?? body.image ?? null;
    const category = body.category ?? null;

    if (!name || price === undefined || Number.isNaN(price)) {
      return res.status(400).json({ message: "Invalid product payload: name and price are required" });
    }

    const createData: any = {
      name,
      description,
      price,
      stock: stock ?? 0,
      imageUrl,
      sellerId,
      // include category if your Prisma model has it (your schema above doesn't declare category field)
      // category,
    };

    // delete undefined keys to avoid overriding DB defaults
    Object.keys(createData).forEach((k) => {
      if (createData[k] === undefined) delete createData[k];
    });

    const product = await prisma.product.create({
      data: createData,
    });

    return res.status(201).json(product);
  } catch (err: any) {
    console.error("createProduct error:", err);

    // Prisma known errors (optional)
    if (err.code === "P2002") {
      // unique constraint failed
      return res.status(409).json({ message: "Unique constraint failed", target: err.meta?.target });
    }

    return next(err);
  }
};

// GET ALL PRODUCTS (seller-scoped)
export const getAllProducts = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerIdForReq(req);
    if (!sellerId) {
      return res.status(404).json({ message: "Seller profile not found" });
    }

    const products = await prisma.product.findMany({
      where: { sellerId },
      orderBy: { createdAt: "desc" },
    });

    return res.json(products);
  } catch (err) {
    console.error("getAllProducts error:", err);
    next(err);
  }
};

// GET BY ID
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
    next(err);
  }
};

// UPDATE (JSON)
export const updateProduct = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid product ID" });

    const sellerId = await getSellerIdForReq(req);
    if (!sellerId) return res.status(404).json({ message: "Seller profile not found" });

    const body = req.body || {};
    const updateData: any = {
      name: body.name,
      description: body.description,
      price: body.price !== undefined ? Number(body.price) : undefined,
      stock: body.stock !== undefined ? Number(body.stock) : undefined,
      imageUrl: body.imageUrl ?? body.image ?? undefined,
    };

    // remove undefined
    Object.keys(updateData).forEach((k) => {
      if (updateData[k] === undefined) delete updateData[k];
    });

    const updated = await prisma.product.updateMany({
      where: { id, sellerId },
      data: updateData,
    });

    if (updated.count === 0) return res.status(404).json({ message: "Product not found or unauthorized" });

    const refreshed = await prisma.product.findUnique({ where: { id } });
    return res.json(refreshed);
  } catch (err) {
    console.error("updateProduct error:", err);
    next(err);
  }
};

// UPDATE STOCK
export const updateStock = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    const stock = Number(req.body.stock);
    if (Number.isNaN(id) || Number.isNaN(stock)) return res.status(400).json({ message: "Invalid payload" });

    const sellerId = await getSellerIdForReq(req);
    if (!sellerId) return res.status(404).json({ message: "Seller profile not found" });

    const updated = await prisma.product.updateMany({ where: { id, sellerId }, data: { stock } });
    if (updated.count === 0) return res.status(404).json({ message: "Product not found or unauthorized" });

    return res.json({ message: "Stock updated successfully" });
  } catch (err) {
    console.error("updateStock error:", err);
    next(err);
  }
};

// GET LOW STOCK
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
    next(err);
  }
};

// DELETE
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
    next(err);
  }
};
