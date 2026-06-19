import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";

export const getSellerId = async (
  req: AuthRequest
): Promise<number | null> => {
  if (req.user?.sellerId) {
    return req.user.sellerId;
  }

  if (!req.user?.id) {
    return null;
  }

  const user = await prisma.user.findUnique({
    where: {
      id: req.user.id,
    },
    select: {
      sellerId: true,
    },
  });

  return user?.sellerId ?? null;
};