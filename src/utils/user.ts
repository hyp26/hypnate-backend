import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";

export const getSellerIdForReq = async (req: AuthRequest): Promise<number | null> => {
  const userId = req.user?.id;
  if (!userId) return null;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  return user?.sellerId ?? null;
};
