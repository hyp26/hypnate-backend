import { Request, Response, NextFunction } from "express";
import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";
import { getSellerIdForReq } from "../utils/user";
import { productSchema } from "../utils/validation";


//
// CREATE PRODUCT (JSON ONLY)
// Image is already uploaded → frontend sends imageUrl
//
export const createProduct = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerIdForReq(req);
    if (!sellerId) {
      return res.status(400).json({ message: "Seller account not found" });
    }

    // Validate request body
    const parsed = productSchema.parse({
      ...req.body,
      price: Number(req.body.price),
      stock: Number(req.body.stock),
    });

    const product = await prisma.product.create({
      data: {
        ...parsed,
        sellerId,
      },
    });

    return res.status(201).json(product);

  } catch (err: any) {
    console.error("createProduct error:", err);

    if (err.name === "ZodError") {
      return res.status(400).json({ message: err.errors });
    }

    next(err);
  }
};



//
// GET ALL PRODUCTS (Seller scoped)
//
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
    next(err);
  }
};



//
// GET PRODUCT BY ID
//
export const getProductById = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
      return res.status(400).json({ message: "Invalid product ID" });
    }

    const sellerId = await getSellerIdForReq(req);
    if (!sellerId) {
      return res.status(404).json({ message: "Seller profile not found" });
    }

    const product = await prisma.product.findFirst({
      where: { id, sellerId },
    });

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    return res.json(product);

  } catch (err) {
    console.error("getProductById error:", err);
    next(err);
  }
};



//
// UPDATE PRODUCT
// JSON-based update (imageUrl optional)
//
export const updateProduct = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
      return res.status(400).json({ message: "Invalid product ID" });
    }

    const sellerId = await getSellerIdForReq(req);
    if (!sellerId) {
      return res.status(404).json({ message: "Seller profile not found" });
    }

    const { name, description, price, stock, imageUrl } = req.body;

    const updateData: any = {
      name,
      description,
      price: price !== undefined ? Number(price) : undefined,
      stock: stock !== undefined ? Number(stock) : undefined,
      imageUrl: imageUrl ?? undefined,
    };

    // Remove undefined fields so Prisma doesn't overwrite values
    Object.keys(updateData).forEach((key) => {
      if (updateData[key] === undefined) delete updateData[key];
    });

    const updated = await prisma.product.updateMany({
      where: { id, sellerId },
      data: updateData,
    });

    if (updated.count === 0) {
      return res.status(404).json({ message: "Product not found or unauthorized" });
    }

    const refreshed = await prisma.product.findUnique({ where: { id } });
    return res.json(refreshed);

  } catch (err) {
    console.error("updateProduct error:", err);
    next(err);
  }
};



//
// UPDATE STOCK
//
export const updateStock = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    const stock = Number(req.body.stock);

    if (Number.isNaN(id) || Number.isNaN(stock)) {
      return res.status(400).json({ message: "Invalid stock update payload" });
    }

    const sellerId = await getSellerIdForReq(req);
    if (!sellerId) {
      return res.status(404).json({ message: "Seller profile not found" });
    }

    const updated = await prisma.product.updateMany({
      where: { id, sellerId },
      data: { stock },
    });

    if (updated.count === 0) {
      return res.status(404).json({ message: "Product not found or unauthorized" });
    }

    return res.json({ message: "Stock updated successfully" });

  } catch (err) {
    next(err);
  }
};



//
// GET LOW STOCK PRODUCTS (<10)
//
export const getLowStockProducts = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerIdForReq(req);
    if (!sellerId) {
      return res.status(404).json({ message: "Seller profile not found" });
    }

    const products = await prisma.product.findMany({
      where: { sellerId, stock: { lt: 10 } },
      orderBy: { stock: "asc" },
    });

    return res.json(products);

  } catch (err) {
    next(err);
  }
};



//
// DELETE PRODUCT
//
export const deleteProduct = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);

    if (Number.isNaN(id)) {
      return res.status(400).json({ message: "Invalid product ID" });
    }

    const sellerId = await getSellerIdForReq(req);
    if (!sellerId) {
      return res.status(404).json({ message: "Seller profile not found" });
    }

    const deleted = await prisma.product.deleteMany({
      where: { id, sellerId },
    });

    if (deleted.count === 0) {
      return res.status(404).json({ message: "Product not found or unauthorized" });
    }

    return res.json({ message: "Product deleted successfully" });

  } catch (err) {
    next(err);
  }
};
