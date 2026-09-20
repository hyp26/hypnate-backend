import { Request, Response, NextFunction } from "express";
import jwt, { JwtPayload } from "jsonwebtoken";
import { JWT_SECRET } from "../utils/jwtConfig";

export interface AuthRequest extends Request {
  user?: {
    id: number;
    role: string;
    sellerId: number | null;
    email?: string;
  };
  userId?: number;
}

interface AccessTokenPayload extends JwtPayload {
  id: number;
  role: string;
  sellerId: number | null;
}

function getAccessToken(req: Request): string | null {
  const cookieToken = req.cookies?.accessToken;

  if (typeof cookieToken === "string" && cookieToken.trim()) {
    return cookieToken;
  }

  const authorization = req.headers.authorization;

  if (authorization?.startsWith("Bearer ")) {
    const bearerToken = authorization.slice("Bearer ".length).trim();

    if (bearerToken) {
      return bearerToken;
    }
  }

  return null;
}

export const verifyToken = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void => {
  const token = getAccessToken(req);

  if (!token) {
    res.status(401).json({
      message: "Authentication required",
    });
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    if (
      typeof decoded !== "object" ||
      decoded === null ||
      typeof decoded.id !== "number" ||
      typeof decoded.role !== "string"
    ) {
      res.status(401).json({
        message: "Invalid authentication token",
      });
      return;
    }

    const payload = decoded as AccessTokenPayload;

    req.user = {
      id: payload.id,
      role: payload.role,
      sellerId:
        typeof payload.sellerId === "number"
          ? payload.sellerId
          : null,
    };

    req.userId = payload.id;

    next();
  } catch {
    res.status(401).json({
      message: "Invalid or expired authentication token",
    });
  }
};

export default verifyToken;
