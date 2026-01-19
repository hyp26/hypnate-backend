
import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";

/**
 * Safely resolve sellerId for the authenticated user
 * Works for:
 * - JWT users
 * - OAuth users
 */
export const getSellerIdForReq = async (
  req: AuthRequest
): Promise<number | null> => {
  // JWT payload already contains sellerId
  if (req.user?.sellerId) {
    return req.user.sellerId;
  }

  // Fallback: fetch from DB using user id
  if (!req.user?.id) {
    return null;
  }

  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { sellerId: true },
  });

  return user?.sellerId ?? null;
};
