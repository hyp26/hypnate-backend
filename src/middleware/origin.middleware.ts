import { Request, Response, NextFunction } from "express";
import { ENV } from "../config/env";

const normalizeOrigin = (value: string): string => {
  try {
    return new URL(value).origin;
  } catch {
    return value.replace(/\/+$/, "");
  }
};

const allowedOrigins = new Set<string>([
  normalizeOrigin(ENV.FRONTEND_URL),
  "https://hypnate.in",
  "https://www.hypnate.in",
]);

if (ENV.NODE_ENV !== "production") {
  [
    "http://localhost:3000",
    "http://localhost:5173",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
  ].forEach((origin) => allowedOrigins.add(origin));
};

/**
 * Protect browser state-changing requests against cross-site requests.
 *
 * Requests without an Origin header are allowed because server-to-server
 * callers such as Telegram, WhatsApp and internal workers normally do not
 * send an Origin header.
 */
export const verifyRequestOrigin = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    next();
    return;
  }

  const origin = req.get("origin");

  if (!origin || allowedOrigins.has(origin)) {
    next();
    return;
  }

  res.status(403).json({
    success: false,
    message: "Forbidden",
  });
};