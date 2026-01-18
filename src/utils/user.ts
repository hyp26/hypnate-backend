import { Request } from "express";
import prisma from "../prisma/client";

export const getSellerIdForReq = async (req: Request) => {
  if (req.user?.sellerId) {
    return req.user.sellerId;
  }

  if (!req.user?.id) {
    return undefined;
  }

  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { sellerId: true },
  });

  return typeof user?.sellerId === "number" ? user.sellerId : undefined;
};
