import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET as string;
const REFRESH_SECRET = process.env.REFRESH_SECRET as string;
const IS_PROD = process.env.NODE_ENV === "production";

export interface JwtUser {
  id: number;
  role: "ADMIN" | "SELLER";
  sellerId?: number | null;
}

export interface AuthRequest extends Request {
  user?: JwtUser;
}

/* ----------------------------------------------------
   VERIFY TOKEN (reads from httpOnly cookie)
---------------------------------------------------- */
export const verifyToken = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  const token = req.cookies?.accessToken;

  if (!token) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtUser;
    req.user = decoded;
    return next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      // Tell the frontend to refresh — it should call POST /api/auth/refresh
      // then retry the original request
      return res.status(401).json({
        message: "Token expired",
        code: "TOKEN_EXPIRED",
      });
    }

    return res.status(401).json({ message: "Invalid token" });
  }
};

/* ----------------------------------------------------
   REQUIRE ROLE
   Usage: router.get("/admin", verifyToken, requireRole("ADMIN"), handler)
---------------------------------------------------- */
export const requireRole = (...roles: Array<"ADMIN" | "SELLER">) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: "Forbidden: insufficient permissions" });
    }

    return next();
  };
};

/* ----------------------------------------------------
   OPTIONAL AUTH
   Use on routes that work for both guests and logged-in users.
   Does NOT return 401 if no token — just sets req.user if valid.
   Usage: router.get("/feed", optionalAuth, handler)
---------------------------------------------------- */
export const optionalAuth = (
  req: AuthRequest,
  _res: Response,
  next: NextFunction
) => {
  const token = req.cookies?.accessToken;

  if (!token) return next();

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtUser;
    req.user = decoded;
  } catch {
    // Token invalid or expired — continue as guest
  }

  return next();
};

/* ----------------------------------------------------
   SELLER ONLY GUARD
   Ensures the resource sellerId matches the logged-in seller.
   Prevents sellers from accessing other sellers' data.
   Usage: add sellerGuard after verifyToken on seller routes
---------------------------------------------------- */
export const sellerGuard = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  if (!req.user) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  // ADMINs can access any seller's data
  if (req.user.role === "ADMIN") return next();

  // For SELLERs, sellerId in token must match sellerId in request
  const requestedSellerId =
    parseInt(req.params.sellerId) ||
    parseInt(req.body.sellerId) ||
    parseInt(req.query.sellerId as string);

  if (requestedSellerId && req.user.sellerId !== requestedSellerId) {
    return res.status(403).json({ message: "Forbidden: not your resource" });
  }

  return next();
};