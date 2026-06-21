import { Request, Response, NextFunction, RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { ENV } from "../config/env";

const JWT_SECRET = ENV.JWT_SECRET;

/* ----------------------------------------------------
   TYPES
---------------------------------------------------- */
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
export const verifyToken: RequestHandler = (req, res, next) => {
  const authReq = req as AuthRequest;

  const token = authReq.cookies?.accessToken;

  if (!token) {
    return res.status(401).json({
      message: "Not authenticated",
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtUser;

    authReq.user = decoded;

    return next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return res.status(401).json({
        message: "Token expired",
        code: "TOKEN_EXPIRED",
      });
    }

    return res.status(401).json({
      message: "Invalid token",
    });
  }
};

/* ----------------------------------------------------
   REQUIRE ROLE
---------------------------------------------------- */
export const requireRole = (...roles: Array<"ADMIN" | "SELLER">) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({
        message: "Not authenticated",
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        message: "Forbidden: insufficient permissions",
      });
    }

    return next();
  };
};

/* ----------------------------------------------------
   OPTIONAL AUTH
---------------------------------------------------- */
export const optionalAuth = (
  req: AuthRequest,
  _res: Response,
  next: NextFunction
) => {
  const token = req.cookies?.accessToken;

  if (!token) {
    return next();
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtUser;
    req.user = decoded;
  } catch {
    // Continue as guest
  }

  return next();
};

/* ----------------------------------------------------
   SELLER GUARD
---------------------------------------------------- */
export const sellerGuard = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  if (!req.user) {
    return res.status(401).json({
      message: "Not authenticated",
    });
  }

  // Admins bypass seller checks
  if (req.user.role === "ADMIN") {
    return next();
  }

  let requestedSellerId: number | undefined;

  if (req.params?.sellerId) {
    requestedSellerId = Number(req.params.sellerId);
  } else if (req.body?.sellerId) {
    requestedSellerId = Number(req.body.sellerId);
  } else if (req.query?.sellerId) {
    requestedSellerId = Number(req.query.sellerId);
  }

  if (
    requestedSellerId !== undefined &&
    !Number.isNaN(requestedSellerId) &&
    req.user.sellerId !== requestedSellerId
  ) {
    return res.status(403).json({
      message: "Forbidden: not your resource",
    });
  }

  return next();
};