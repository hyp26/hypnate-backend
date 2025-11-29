import { Request, Response, NextFunction } from "express";
import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";
import { uploadBufferToCloudinary } from "../utils/cloudinary";
import { getSellerIdForReq } from "../utils/user";


// CREATE PRODUCT (multipart/form-data)
export const createProduct = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { name, description, price, stock, imageUrl } = req.body;

    const sellerId = await getSellerIdForReq(req);
    if (!sellerId) {
      return res.status(400).json({ message: "Seller account not found" });
    }

    let finalImageUrl: string | null = null;

    // 1. File uploaded via form-data
    if (req.file) {
      const mode = process.env.UPLOAD_MODE || "cloud";

      if (mode === "cloud") {
        const result = await uploadBufferToCloudinary(req.file.buffer, "hypnate/products");
        finalImageUrl = result.secure_url;
      } else {
        // local mode → file saved via multer.diskStorage
        finalImageUrl = `/uploads/${req.file.filename}`;
      }
    }

    // 2. JSON fallback (if no file uploaded)
    if (!finalImageUrl && imageUrl) {
      finalImageUrl = imageUrl;
    }

    const product = await prisma.product.create({
      data: {
        name,
        description,
        price: Number(price),
        stock: Number(stock),
        imageUrl: finalImageUrl,
        sellerId,
      },
    });

    return res.status(201).json(product);

  } catch (err) {
    console.error("createProduct error:", err);
    next(err);
  }
};


// GET ALL PRODUCTS
export const getAllProducts = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerIdForReq(req);
    if (!sellerId) return res.status(404).json({ message: "Seller profile not found" });

    const products = await prisma.product.findMany({
      where: { sellerId },
      orderBy: { createdAt: "desc" },
    });

    res.json(products);
  } catch (err) {
    next(err);
  }
};


// GET PRODUCT BY ID
export const getProductById = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);

    if (Number.isNaN(id)) {
      return res.status(400).json({ message: "Invalid product ID" });
    }

    const sellerId = await getSellerIdForReq(req);

    if (sellerId === null || sellerId === undefined) {
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


// UPDATE PRODUCT
export const updateProduct = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    const { name, description, price, stock, imageUrl } = req.body;

    const sellerId = await getSellerIdForReq(req);
    if (!sellerId) return res.status(404).json({ message: "Seller not found" });

    let finalImageUrl: string | undefined = undefined;

    // 1. If a new file was uploaded
    if (req.file) {
      const mode = process.env.UPLOAD_MODE || "cloud";

      if (mode === "cloud") {
        const result = await uploadBufferToCloudinary(req.file.buffer, "hypnate/products");
        finalImageUrl = result.secure_url;
      } else {
        finalImageUrl = `/uploads/${req.file.filename}`;
      }
    }

    // 2. JSON fallback
    if (!req.file && imageUrl) {
      finalImageUrl = imageUrl;
    }

    const updateData: any = {
      name,
      description,
      price: price ? Number(price) : undefined,
      stock: stock ? Number(stock) : undefined,
    };

    // only include imageUrl if we have a new one
    if (finalImageUrl !== undefined) {
      updateData.imageUrl = finalImageUrl;
    }

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


// UPDATE STOCK
export const updateStock = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    const { stock } = req.body;

    const sellerId = await getSellerIdForReq(req);
    if (sellerId === null || sellerId === undefined) {
      return res.status(404).json({ message: "Seller profile not found" });
    }

    const updated = await prisma.product.updateMany({
      where: { id, sellerId },
      data: { stock: Number(stock) },
    });

    if (updated.count === 0)
      return res.status(404).json({ message: "Product not found or unauthorized" });

    res.json({ message: "Stock updated successfully" });

  } catch (err) {
    next(err);
  }
};


// LOW STOCK (<10)
export const getLowStockProducts = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerIdForReq(req);
    if (sellerId === null || sellerId === undefined) {
      return res.status(404).json({ message: "Seller profile not found" });
    }

    const products = await prisma.product.findMany({
      where: { sellerId, stock: { lt: 10 } },
      orderBy: { stock: "asc" },
    });

    res.json(products);

  } catch (err) {
    next(err);
  }
};


// DELETE PRODUCT
export const deleteProduct = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    const sellerId = await getSellerIdForReq(req);

    if (sellerId === null || sellerId === undefined) {
      return res.status(404).json({ message: "Seller profile not found" });
    }

    const deleted = await prisma.product.deleteMany({
      where: { id, sellerId },
    });

    if (deleted.count === 0)
      return res.status(404).json({ message: "Product not found or unauthorized" });

    res.json({ message: "Product deleted successfully" });

  } catch (err) {
    next(err);
  }
};
