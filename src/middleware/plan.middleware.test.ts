import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { Response, NextFunction } from "express";
import { requirePlanFeature } from "./plan.middleware";
import type { AuthRequest } from "./authMiddleware";

const daysFromNow = (days: number) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000);

interface SellerRow {
  activePlan: string | null;
  planStatus: string | null;
  planCurrentPeriodEnd: Date | null;
  planActivatedAt: Date | null;
  status: "ACTIVE" | "PENDING" | "SUSPENDED" | "REJECTED";
  freeAccessGrant: null;
  trialPlan: string | null;
  trialEndsAt: Date | null;
}

/**
 * Invoke the middleware against a stubbed seller row and return
 * the outcome: the HTTP response that was sent, or "next" when the
 * request was allowed through.
 */
async function runMiddleware(
  seller: SellerRow | null,
  feature: Parameters<typeof requirePlanFeature>[0],
): Promise<{ status?: number; body?: any; allowed: boolean }> {
  let status: number | undefined;
  let body: any;
  let allowed = false;
  let jsonSent = false;

  const req = {
    user: { id: 1, role: "SELLER", sellerId: 42 },
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

  const next: NextFunction = () => {
    allowed = true;
  };

  const middleware = requirePlanFeature(feature, {
    loadSeller: async () => seller,
  });

  await middleware(req, res as Response, next);

  return { status, body, allowed: allowed && !jsonSent };
}

describe("requirePlanFeature delegates to getPlanAccess", () => {
  it("PENDING subscription is denied access to a paid feature", async () => {
    // Old bug: PENDING with a future period end was treated as paid.
    const r = await runMiddleware(
      {
        activePlan: "starter",
        planStatus: "PENDING",
        planCurrentPeriodEnd: daysFromNow(10),
        planActivatedAt: null,
        status: "ACTIVE",
        freeAccessGrant: null,
        trialPlan: null,
        trialEndsAt: null,
      },
      "commerceWorkspace",
    );
    assert.equal(r.allowed, false);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "PLAN_REQUIRED");
  });

  it("CANCELLED subscription without an activated paid period is denied", async () => {
    // Never activated (planActivatedAt missing): no retained access.
    const r = await runMiddleware(
      {
        activePlan: "starter",
        planStatus: "CANCELLED",
        planCurrentPeriodEnd: daysFromNow(10),
        planActivatedAt: null,
        status: "ACTIVE",
        freeAccessGrant: null,
        trialPlan: null,
        trialEndsAt: null,
      },
      "commerceWorkspace",
    );
    assert.equal(r.allowed, false);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "PLAN_REQUIRED");
  });

  it("CANCELLED subscription after the paid period ends is denied", async () => {
    const r = await runMiddleware(
      {
        activePlan: "starter",
        planStatus: "CANCELLED",
        planCurrentPeriodEnd: daysFromNow(-1),
        planActivatedAt: daysFromNow(-30),
        trialPlan: null,
        trialEndsAt: null,
        status: "ACTIVE",
        freeAccessGrant: null,
      },
      "commerceWorkspace",
    );
    assert.equal(r.allowed, false);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "PLAN_REQUIRED");
  });

  it("CANCELLED subscription retains access until the paid period ends (authoritative rule)", async () => {
    // getPlanAccess grants CANCELLED access only when the plan was
    // previously activated and the paid period is still in the
    // future — the middleware must match, not diverge.
    const r = await runMiddleware(
      {
        activePlan: "starter",
        planStatus: "CANCELLED",
        planCurrentPeriodEnd: daysFromNow(10),
        planActivatedAt: daysFromNow(-30),
        trialPlan: null,
        trialEndsAt: null,
        status: "ACTIVE",
        freeAccessGrant: null,
      },
      "commerceWorkspace",
    );
    assert.equal(r.allowed, true);
  });

  it("valid paid subscription with the required feature is allowed", async () => {
    const r = await runMiddleware(
      {
        activePlan: "pro",
        planStatus: "ACTIVE",
        planCurrentPeriodEnd: daysFromNow(30),
        planActivatedAt: daysFromNow(-1),
        trialPlan: null,
        trialEndsAt: null,
        status: "ACTIVE",
        freeAccessGrant: null,
      },
      "advancedAnalytics",
    );
    assert.equal(r.allowed, true);
    assert.equal(r.status, undefined);
  });

  it("valid subscription without the required feature is denied with PLAN_UPGRADE_REQUIRED", async () => {
    const r = await runMiddleware(
      {
        activePlan: "starter",
        planStatus: "ACTIVE",
        planCurrentPeriodEnd: daysFromNow(30),
        planActivatedAt: daysFromNow(-1),
        status: "ACTIVE",
        freeAccessGrant: null,
        trialPlan: null,
        trialEndsAt: null,
      },
      "advancedAnalytics",
    );
    assert.equal(r.allowed, false);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "PLAN_UPGRADE_REQUIRED");
    assert.equal(r.body.currentPlan, "starter");
    assert.equal(r.body.requiredPlan, "pro");
  });

  it("missing billing data (no seller record) follows the authoritative denial", async () => {
    const r = await runMiddleware(null, "commerceWorkspace");
    assert.equal(r.allowed, false);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "PLAN_REQUIRED");
  });

  it("unknown plan value never grants access", async () => {
    const r = await runMiddleware(
      {
        activePlan: "enterprise",
        planStatus: "ACTIVE",
        planCurrentPeriodEnd: daysFromNow(30),
        planActivatedAt: daysFromNow(-1),
        trialPlan: null,
        trialEndsAt: null,
        status: "ACTIVE",
        freeAccessGrant: null,
      },
      "commerceWorkspace",
    );
    assert.equal(r.allowed, false);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "PLAN_REQUIRED");
  });

  it("valid trial grants access to trial-plan features", async () => {
    const r = await runMiddleware(
      {
        activePlan: null,
        planStatus: "CREATED",
        planCurrentPeriodEnd: null,
        planActivatedAt: null,
        trialPlan: "starter",
        trialEndsAt: daysFromNow(3),
        status: "ACTIVE",
        freeAccessGrant: null,
      },
      "commerceWorkspace",
    );
    assert.equal(r.allowed, true);
  });

  it("expired trial is denied", async () => {
    const r = await runMiddleware(
      {
        activePlan: null,
        planStatus: "CREATED",
        planCurrentPeriodEnd: null,
        planActivatedAt: null,
        trialPlan: "starter",
        trialEndsAt: daysFromNow(-3),
        status: "ACTIVE",
        freeAccessGrant: null,
      },
      "commerceWorkspace",
    );
    assert.equal(r.allowed, false);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "PLAN_REQUIRED");
  });
});

describe("requirePlanFeature auth guards", () => {
  it("rejects unauthenticated requests with 401", async () => {
    let status: number | undefined;
    let body: any;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json(payload: any) {
        body = payload;
        return this;
      },
    } as unknown as Response;

    const middleware = requirePlanFeature("commerceWorkspace");
    await middleware(
      {} as unknown as AuthRequest,
      res,
      (() => {}) as NextFunction,
    );
    assert.equal(status, 401);
    assert.equal(body.message, "Not authenticated");
  });

  it("rejects users without a seller account with SELLER_REQUIRED", async () => {
    let status: number | undefined;
    let body: any;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json(payload: any) {
        body = payload;
        return this;
      },
    } as unknown as Response;

    const middleware = requirePlanFeature("commerceWorkspace");
    await middleware(
      { user: { id: 1, role: "USER", sellerId: null } } as unknown as AuthRequest,
      res,
      (() => {}) as NextFunction,
    );
    assert.equal(status, 403);
    assert.equal(body.code, "SELLER_REQUIRED");
  });

  it("lets ADMIN users bypass plan checks", async () => {
    let allowed = false;
    let status: number | undefined;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json() {
        return this;
      },
    } as unknown as Response;

    const middleware = requirePlanFeature("commerceWorkspace");
    await middleware(
      { user: { id: 1, role: "ADMIN", sellerId: null } } as unknown as AuthRequest,
      res,
      () => {
        allowed = true;
      },
    );
    assert.equal(allowed, true);
    assert.equal(status, undefined);
  });
});
