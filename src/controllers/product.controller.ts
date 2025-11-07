import { Request, Response, NextFunction } from "express";
import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";
import { getSellerIdForReq } from "../utils/user";

// CREATE product
export const createProduct = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { name, description, price, stock, imageUrl } = req.body;

    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { sellerId: true },
    });
    if (!user?.sellerId) {
      return res.status(400).json({ message: "Seller account not found" });
    }

    const product = await prisma.product.create({
      data: {
        name,
        description,
        price,
        stock,
        imageUrl,
        sellerId: user.sellerId,
      },
    });

    res.status(201).json(product);
  } catch (err) {
    next(err);
  }
};


// GET all products
export const getAllProducts = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: { seller: true },
    });

    if (!user?.seller) {
      return res.status(404).json({ message: "Seller profile not found" });
    }

    const products = await prisma.product.findMany({
      where: { sellerId: user.seller.id },
      orderBy: { createdAt: "desc" },
    });

    res.json(products);
  } catch (err) {
    next(err);
  }
};

// GET single product
export const getProductById = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const idParam = req.params.id;
    const id = Number(idParam);

    // Defensive check: ensure numeric id
    if (!idParam || Number.isNaN(id)) {
      return res.status(400).json({ message: "Invalid or missing product ID" });
    }

    // Fetch seller for this user
    const user = await prisma.user.findUnique({
      where: { id: req.user?.id },
      include: { seller: true },
    });

    if (!user?.seller) {
      return res.status(404).json({ message: "Seller not found for user" });
    }

    // Fetch product by ID and seller ownership
    const product = await prisma.product.findFirst({
      where: {
        id: id,
        sellerId: user.seller.id,
      },
    });

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    return res.json(product);
  } catch (err) {
    console.error("Error in getProductById:", err);
    next(err);
  }
};


// UPDATE product
export const updateProduct = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id);
    const { name, description, price, stock, imageUrl } = req.body;

    // find the seller linked to this user
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: { seller: true },
    });

    if (!user?.seller) {
      return res.status(404).json({ message: "Seller not found" });
    }

    const updated = await prisma.product.updateMany({
      where: { id, sellerId: user.seller.id },
      data: { name, description, price, stock, imageUrl },
    });

    if (updated.count === 0) {
      return res.status(404).json({ message: "Product not found or unauthorized" });
    }

    const refreshed = await prisma.product.findUnique({ where: { id } });
    res.json(refreshed);
  } catch (err) {
    next(err);
  }
};

// UPDATE stock level
export const updateStock = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id);
    const { stock } = req.body;

    // Get seller ID linked to the current user
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: { seller: true },
    });

    if (!user?.seller) {
      return res.status(404).json({ message: "Seller not found" });
    }

    const updated = await prisma.product.updateMany({
      where: { id, sellerId: user.seller.id },
      data: { stock },
    });

    if (updated.count === 0) {
      return res.status(404).json({ message: "Product not found or unauthorized" });
    }

    res.json({ message: "Stock updated successfully" });
  } catch (err) {
    next(err);
  }
};


// LOW-STOCK alert (<10)
export const getLowStockProducts = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const sellerId = await getSellerIdForReq(req);
    if (!sellerId) return res.status(404).json({ message: "Seller not found for user" });

    const products = await prisma.product.findMany({
      where: {
        sellerId,
        stock: { lt: 10 },
      },
      orderBy: { stock: "asc" },
    });
    res.json(products);
  } catch (err) {
    next(err);
  }
};

// DELETE product
export const deleteProduct = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id);
    const deleted = await prisma.product.deleteMany({
      where: { id, sellerId: req.user!.id },
    });

    if (deleted.count === 0)
      return res.status(404).json({ message: "Product not found or unauthorized" });

    res.json({ message: "Product deleted successfully" });
  } catch (err) {
    next(err);
  }
};
