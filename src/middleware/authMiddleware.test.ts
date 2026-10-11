import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import jwt from "jsonwebtoken";
import type { Response, NextFunction } from "express";
import {
  createVerifyToken,
  isSellerBlocked,
  type AuthRequest,
  type SellerStatusRow,
} from "./authMiddleware";
import { JWT_SECRET } from "../utils/jwtConfig";

const signAccessToken = (payload: {
  id: number;
  role: string;
  sellerId: number | null;
}) => jwt.sign(payload, JWT_SECRET, { expiresIn: "15m" });

interface Outcome {
  status?: number;
  body?: any;
  allowed: boolean;
  error?: Error;
  reqUser?: AuthRequest["user"];
}

/**
 * Invoke the middleware against a stubbed seller-status lookup and
 * return the outcome: the HTTP response that was sent, the error
 * forwarded to next(), or "allowed" when the request passed.
 */
async function runVerify(
  token: string | null,
  sellerStatus: SellerStatusRow | null | Error,
): Promise<Outcome> {
  let status: number | undefined;
  let body: any;
  let jsonSent = false;
  let allowed = false;
  let error: Error | undefined;
  let loadCalls = 0;

  const req = {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    cookies: {},
  } as unknown as AuthRequest;

  const res = {
    status(code: number) {
      status = code;
      return this as unknown as Response;
    },
    json(payload: any) {
      body = payload;
      jsonSent = true;
      return this as unknown as Response;
    },
  } as unknown as Response;

  const next: NextFunction = (err?: any) => {
    if (err) error = err as Error;
    else allowed = true;
  };

  const loadSellerStatus = async () => {
    loadCalls++;
    if (sellerStatus instanceof Error) throw sellerStatus;
    return sellerStatus;
  };

  const middleware = createVerifyToken({ loadSellerStatus });
  await middleware(req, res, next);

  return {
    status,
    body,
    allowed: allowed && !jsonSent,
    error,
    reqUser: req.user,
    loadCalls,
  };
}

describe("isSellerBlocked (shared suspension rule)", () => {
  it("blocks SUSPENDED and INACTIVE in any letter case", () => {
    assert.equal(isSellerBlocked("SUSPENDED"), true);
    assert.equal(isSellerBlocked("suspended"), true);
    assert.equal(isSellerBlocked("Inactive"), true);
  });

  it("does not block ACTIVE or other values", () => {
    assert.equal(isSellerBlocked("ACTIVE"), false);
    assert.equal(isSellerBlocked("TRIALING"), false);
    assert.equal(isSellerBlocked(""), false);
  });

  it("does not block missing status values", () => {
    assert.equal(isSellerBlocked(null), false);
    assert.equal(isSellerBlocked(undefined), false);
    assert.equal(isSellerBlocked(42), false);
  });
});

describe("verifyToken seller-suspension enforcement", () => {
  const sellerToken = signAccessToken({
    id: 7,
    role: "SELLER",
    sellerId: 42,
  });

  it("rejects a suspended seller holding an otherwise-valid access token", async () => {
    const r = await runVerify(sellerToken, { status: "SUSPENDED" });
    assert.equal(r.allowed, false);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "ACCOUNT_SUSPENDED");
    // No sensitive internal details in the response.
    assert.equal(typeof r.body.message, "string");
    assert.ok(!JSON.stringify(r.body).includes("SUSPENDED_"));
  });

  it("rejects an INACTIVE seller (admin-panel blocked status)", async () => {
    const r = await runVerify(sellerToken, { status: "INACTIVE" });
    assert.equal(r.allowed, false);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "ACCOUNT_SUSPENDED");
  });

  it("allows an active seller with a valid access token", async () => {
    const r = await runVerify(sellerToken, { status: "ACTIVE" });
    assert.equal(r.allowed, true);
    assert.equal(r.status, undefined);
    assert.deepEqual(r.reqUser, {
      id: 7,
      role: "SELLER",
      sellerId: 42,
    });
  });

  it("does not perform a seller lookup for users without a seller attachment", async () => {
    const adminToken = signAccessToken({
      id: 1,
      role: "ADMIN",
      sellerId: null,
    });
    const r = await runVerify(adminToken, { status: "SUSPENDED" });
    // Admin access must not be blocked by a seller-status check.
    assert.equal(r.allowed, true);
    assert.equal((r as any).loadCalls, 0);
    assert.equal(r.reqUser?.sellerId, null);
  });

  it("preserves existing behavior when the seller record is missing", async () => {
    const r = await runVerify(sellerToken, null);
    assert.equal(r.allowed, true);
  });

  it("fails closed when the status lookup throws", async () => {
    const r = await runVerify(sellerToken, new Error("db down"));
    assert.equal(r.allowed, false);
    assert.equal(r.status, undefined);
    assert.ok(r.error instanceof Error);
    assert.equal(r.error!.message, "db down");
  });
});

describe("verifyToken existing authentication behavior preserved", () => {
  it("rejects a request without a token", async () => {
    const r = await runVerify(null, { status: "SUSPENDED" });
    assert.equal(r.allowed, false);
    assert.equal(r.status, 401);
    assert.equal(r.body.message, "Authentication required");
  });

  it("rejects an invalid token", async () => {
    const r = await runVerify("not-a-jwt", { status: "SUSPENDED" });
    assert.equal(r.allowed, false);
    assert.equal(r.status, 401);
    assert.equal(r.body.message, "Invalid or expired authentication token");
  });

  it("rejects an expired token even for an active seller", async () => {
    const expired = jwt.sign(
      { id: 7, role: "SELLER", sellerId: 42 },
      JWT_SECRET,
      { expiresIn: "-1s" },
    );
    const r = await runVerify(expired, { status: "ACTIVE" });
    assert.equal(r.allowed, false);
    assert.equal(r.status, 401);
  });

  it("rejects a token with a non-numeric id", async () => {
    const malformed = jwt.sign(
      { id: "seven", role: "SELLER", sellerId: 42 },
      JWT_SECRET,
      { expiresIn: "15m" },
    );
    const r = await runVerify(malformed, { status: "ACTIVE" });
    assert.equal(r.allowed, false);
    assert.equal(r.status, 401);
    assert.equal(r.body.message, "Invalid authentication token");
  });
});
