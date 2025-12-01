import { Request, Response, NextFunction } from "express";
import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";

// GET /api/categories
export const getCategories = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const categories = await prisma.category.findMany({
      orderBy: { name: "asc" },
    });
    return res.json(categories);
  } catch (err) {
    console.error("getCategories error:", err);
    next(err);
  }
};

// POST /api/categories (admin/manager)
export const createCategory = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== "string") {
      return res.status(400).json({ message: "Invalid category name" });
    }

    const existing = await prisma.category.findUnique({ where: { name } });
    if (existing) {
      return res.status(409).json({ message: "Category already exists" });
    }

    const category = await prisma.category.create({ data: { name } });
    return res.status(201).json(category);
  } catch (err) {
    console.error("createCategory error:", err);
    next(err);
  }
};
