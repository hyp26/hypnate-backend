import { Request, Response, NextFunction, RequestHandler } from "express";
import jwt from "jsonwebtoken";

export interface JwtUser {
  id: number;
  role: "ADMIN" | "SELLER";
  sellerId?: number | null;
}

export interface AuthRequest extends Request {
  user?: JwtUser;
}

const JWT_SECRET = process.env.JWT_SECRET as string;

// ✅ IMPORTANT: typed as RequestHandler
export const verifyToken: RequestHandler = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtUser;

    // 🔑 cast ONLY here
    (req as AuthRequest).user = decoded;

    next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};
