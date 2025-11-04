import { Request, Response, NextFunction } from "express";
import prisma from "../prisma/client";

export const getAllProducts = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const products = await prisma.product.findMany();
    res.json(products);
  } catch (error) {
    next(error);
  }
};

export const createProduct = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, price, description, stock, imageUrl } = req.body;
    const newProduct = await prisma.product.create({
      data: {
        name,
        price,
        description,
        stock,
        imageUrl,
      },
    });
    res.status(201).json(newProduct);
  } catch (error) {
    next(error);
  }
};
