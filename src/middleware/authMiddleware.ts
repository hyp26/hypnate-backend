import { Request, Response, NextFunction } from "express";
import jwt, { JwtPayload } from "jsonwebtoken";
import prisma from "../prisma/client";
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

/**
 * Platform-level seller statuses that must block authenticated
 * access. This mirrors the admin-panel convention: setting a
 * seller to any status other than ACTIVE also revokes that
 * seller users' refresh sessions
 * (adminSellers.controller.updateSellerStatus).
 */
const BLOCKED_SELLER_STATUSES = ["SUSPENDED", "INACTIVE"];

/**
 * True when a seller's platform status must block authentication.
 *
 * Exported so the login, refresh, and socket-auth paths apply
 * exactly the same rule as this middleware.
 */
export const isSellerBlocked = (status: unknown): boolean =>
  typeof status === "string" &&
  BLOCKED_SELLER_STATUSES.includes(status.toUpperCase());

/**
 * The seller fields consumed by the seller-status enforcement.
 * Declared structurally so tests can supply a plain object
 * without Prisma's client-thenable return type.
 */
export interface SellerStatusRow {
  status: string;
}

/**
 * Loads a seller's platform status.
 * prisma.seller.findUnique satisfies this type because
 * PrismaPromise<T> extends Promise<T>.
 */
export type LoadSellerStatus = (
  sellerId: number
) => Promise<SellerStatusRow | null>;

const defaultLoadSellerStatus: LoadSellerStatus = (sellerId) =>
  prisma.seller.findUnique({
    where: { id: sellerId },
    select: { status: true },
  });

/**
 * Optional dependency overrides, used by unit tests to stub the
 * seller-status lookup. Production call sites never pass this.
 */
export interface VerifyTokenDeps {
  loadSellerStatus?: LoadSellerStatus;
}

/**
 * Build the access-token verification middleware.
 *
 * Verifies the JWT, then — for users attached to a seller —
 * enforces the seller's current platform status from the
 * database, so a previously issued, otherwise-valid access
 * token cannot bypass an admin suspension.
 */
export const createVerifyToken =
  (deps: VerifyTokenDeps = {}) =>
  async (
    req: AuthRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const token = getAccessToken(req);

    if (!token) {
      res.status(401).json({
        message: "Authentication required",
      });
      return;
    }

    let payload: AccessTokenPayload;

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

      payload = decoded as AccessTokenPayload;
    } catch {
      res.status(401).json({
        message: "Invalid or expired authentication token",
      });
      return;
    }

    /*
     * P1-003: enforce the seller's current platform status.
     *
     * A valid JWT alone is no longer enough once the admin has
     * suspended the seller. Users without a seller attachment
     * (admins, sellerId === null) are not affected.
     */
    if (typeof payload.sellerId === "number") {
      const loadSellerStatus =
        deps.loadSellerStatus ?? defaultLoadSellerStatus;

      let seller: SellerStatusRow | null;

      try {
        seller = await loadSellerStatus(payload.sellerId);
      } catch (err) {
        // Fail closed: a lookup error must not silently allow access.
        next(err as Error);
        return;
      }

      /*
       * A token referencing a seller that no longer exists must
       * not authenticate. Use the standard invalid-token response
       * so no internal detail is exposed.
       */
      if (!seller) {
        res.status(401).json({
          message: "Invalid or expired authentication token",
        });
        return;
      }

      if (isSellerBlocked(seller.status)) {
        res.status(403).json({
          message: "This account is suspended. Please contact support.",
          code: "ACCOUNT_SUSPENDED",
        });
        return;
      }
    }

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
  };

export const verifyToken = createVerifyToken();

export default verifyToken;
