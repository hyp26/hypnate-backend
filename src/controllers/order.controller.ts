import { Request, Response, NextFunction } from "express";
import prisma from "../prisma/client";

export const getAllOrders = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orders = await prisma.order.findMany({
        include: { products: { include: { Product: true } } },
    });
    res.json(orders);
  } catch (error) {
    next(error);
  }
};

export const createOrder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { customer, products } = req.body; // products: [{ productId, quantity }]
    const totalAmount = await products.reduce(async (sumPromise: any, p: any) => {
      const sum = await sumPromise;
      const product = await prisma.product.findUnique({ where: { id: p.productId } });
      return sum + (product?.price || 0) * p.quantity;
    }, Promise.resolve(0));

    const order = await prisma.order.create({
      data: {
        customer,
        totalAmount,
        products: {
          create: products.map((p: any) => ({
            productId: p.productId,
            quantity: p.quantity,
          })),
        },
      },
      include: { products: true },
    });

    res.status(201).json(order);
  } catch (err) {
    next(err);
  }
};