import { Request, Response, NextFunction, CookieOptions } from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import prisma from "../prisma/client";
import { JWT_SECRET } from "../utils/jwtConfig";
import { hashToken } from "../utils/tokenHash";
import { ENV } from "../config/env";

/* ----------------------------------------------------
   TOKENS
---------------------------------------------------- */

/**
 * Admin access tokens are short-lived JWTs signed with the
 * same secret as seller tokens but carry a distinct payload:
 *
 *   { sub: <adminId>, admin: true, role }
 *
 * The `admin: true` claim plus `sub` (instead of `id`) means
 * admin tokens are rejected by the seller-facing verifyToken
 * middleware, and seller tokens are rejected here.
 */
export const ADMIN_ACCESS_TOKEN_MAX_AGE = 15 * 60 * 1000; // 15 minutes
export const ADMIN_REFRESH_TOKEN_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

export const ADMIN_ACCESS_COOKIE = "adminAccessToken";
export const ADMIN_REFRESH_COOKIE = "adminRefreshToken";

interface AdminAccessTokenPayload {
  sub: number;
  admin: true;
  role: AdminRoleValue;
}

type AdminRoleValue = "SUPER_ADMIN" | "ADMIN" | "SUPPORT";

export const createAdminAccessToken = (admin: {
  id: number;
  role: AdminRoleValue;
}): string =>
  jwt.sign(
    {
      sub: admin.id,
      admin: true,
      role: admin.role,
    } satisfies AdminAccessTokenPayload,
    JWT_SECRET,
    { expiresIn: "15m" }
  );

/**
 * Raw refresh token: 48 random bytes, returned only so it can
 * be set as an HttpOnly cookie. Only its SHA-256 hash is stored.
 */
export const createAdminRefreshToken = (): string =>
  crypto.randomBytes(48).toString("hex");

export const hashAdminToken = hashToken;

/* ----------------------------------------------------
   COOKIES
---------------------------------------------------- */

const IS_PROD = ENV.NODE_ENV === "production";

const baseCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: IS_PROD,
  sameSite: IS_PROD ? "none" : "lax",
};

export const setAdminAuthCookies = (
  res: Response,
  accessToken: string,
  refreshToken: string
): void => {
  res.cookie(ADMIN_ACCESS_COOKIE, accessToken, {
    ...baseCookieOptions,
    maxAge: ADMIN_ACCESS_TOKEN_MAX_AGE,
    path: "/",
  });

  res.cookie(ADMIN_REFRESH_COOKIE, refreshToken, {
    ...baseCookieOptions,
    maxAge: ADMIN_REFRESH_TOKEN_MAX_AGE,
    path: "/api/admin/auth/refresh",
  });
};

export const clearAdminAuthCookies = (res: Response): void => {
  res.clearCookie(ADMIN_ACCESS_COOKIE, { path: "/" });
  res.clearCookie(ADMIN_REFRESH_COOKIE, { path: "/api/admin/auth/refresh" });
};

const getAdminAccessToken = (req: Request): string | null => {
  const cookieToken = req.cookies?.[ADMIN_ACCESS_COOKIE];

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
};

/* ----------------------------------------------------
   PERMISSIONS
---------------------------------------------------- */

export type AdminPermission =
  | "VIEW_ADMIN_USERS"
  | "CREATE_ADMIN"
  | "CREATE_SUPPORT"
  | "DELETE_ADMIN"
  | "DELETE_SUPPORT"
  | "CHANGE_ADMIN_ROLE"
  | "CHANGE_SUPPORT_ROLE"
  | "CHANGE_ADMIN_STATUS";

const ROLE_PERMISSIONS: Record<AdminRoleValue, AdminPermission[]> = {
  SUPER_ADMIN: [
    "VIEW_ADMIN_USERS",
    "CREATE_ADMIN",
    "CREATE_SUPPORT",
    "DELETE_ADMIN",
    "DELETE_SUPPORT",
    "CHANGE_ADMIN_ROLE",
    "CHANGE_SUPPORT_ROLE",
    "CHANGE_ADMIN_STATUS",
  ],
  ADMIN: [
    "VIEW_ADMIN_USERS",
    "CREATE_SUPPORT",
    "DELETE_SUPPORT",
    "CHANGE_SUPPORT_ROLE",
  ],
  SUPPORT: [],
};

export const getAdminPermissions = (role: AdminRoleValue): AdminPermission[] =>
  ROLE_PERMISSIONS[role] ?? [];

/* ----------------------------------------------------
   REQUEST SHAPE
---------------------------------------------------- */

export interface AdminAuthRequest extends Request {
  adminUser?: {
    id: number;
    email: string;
    firstName: string;
    lastName: string;
    role: AdminRoleValue;
    status: "ACTIVE" | "INACTIVE" | "SUSPENDED";
    avatarUrl: string | null;
  };
}

/* ----------------------------------------------------
   MIDDLEWARE
---------------------------------------------------- */

/**
 * Verifies the admin access token and resolves the admin
 * account from the database on every request (never trusts
 * the JWT role claim alone).
 */
export const verifyAdminToken = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const token = getAdminAccessToken(req);

    if (!token) {
      res.status(401).json({ message: "Admin authentication required" });
      return;
    }

    let payload: AdminAccessTokenPayload;

    try {
      const decoded = jwt.verify(token, JWT_SECRET);

      if (
        typeof decoded !== "object" ||
        decoded === null ||
        (decoded as { admin?: unknown }).admin !== true ||
        typeof (decoded as { sub?: unknown }).sub !== "number"
      ) {
        throw new Error("Not an admin token");
      }

      payload = decoded as unknown as AdminAccessTokenPayload;
    } catch {
      res
        .status(401)
        .json({ message: "Invalid or expired admin authentication token" });
      return;
    }

    const admin = await prisma.adminUser.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        status: true,
        avatarUrl: true,
      },
    });

    if (!admin || admin.status !== "ACTIVE") {
      res
        .status(403)
        .json({ message: "Admin account is inactive or suspended" });
      return;
    }

    req.adminUser = admin;
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Requires that the authenticated admin holds a specific
 * permission. Must run after verifyAdminToken.
 */
export const requireAdminPermission = (permission: AdminPermission) => {
  return (req: AdminAuthRequest, res: Response, next: NextFunction): void => {
    const admin = req.adminUser;

    if (!admin) {
      res.status(401).json({ message: "Admin authentication required" });
      return;
    }

    if (!getAdminPermissions(admin.role).includes(permission)) {
      res.status(403).json({
        message: `Your ${admin.role.toLowerCase()} account does not have the required permission`,
      });
      return;
    }

    next();
  };
};

/**
 * Restricts a route to specific admin roles (used for
 * platform-wide operations that have no fine-grained
 * permission, e.g. seller suspension).
 */
export const requireAdminRoles = (...roles: AdminRoleValue[]) => {
  return (req: AdminAuthRequest, res: Response, next: NextFunction): void => {
    const admin = req.adminUser;

    if (!admin) {
      res.status(401).json({ message: "Admin authentication required" });
      return;
    }

    if (!roles.includes(admin.role)) {
      res.status(403).json({
        message: "You do not have access to this resource",
      });
      return;
    }

    next();
  };
};
