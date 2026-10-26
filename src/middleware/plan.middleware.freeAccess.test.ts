import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { requirePlanFeature } from "./plan.middleware";

/*
 * Unit tests for the free-access (SUPER_ADMIN grant) integration
 * of requirePlanFeature. The seller loader is stubbed so no
 * database is required; these tests verify the ENTITLEMENT
 * DECISION, not route wiring.
 *
 * NOT EXECUTED in the authoring environment (no Node.js
 * available) — see the PR description for the exact
 * verification status.
 */

type PlanAccessStub = {
  status: string | null;
  activePlan: string | null;
  planStatus: string | null;
  planCurrentPeriodEnd: Date | null;
  planActivatedAt: Date | null;
  trialPlan: string | null;
  trialEndsAt: Date | null;
  freeAccessGrant: { plan: string; expiresAt: Date | null; revokedAt: Date | null } | null;
};

const daysFromNow = (days: number) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000);

const makeSeller = (overrides: Partial<PlanAccessStub> = {}): PlanAccessStub => ({
  status: "ACTIVE",
  activePlan: null,
  planStatus: null,
  planCurrentPeriodEnd: null,
  planActivatedAt: null,
  trialPlan: null,
  trialEndsAt: null,
  freeAccessGrant: null,
  ...overrides,
});

interface FakeCall {
  status: number | null;
  body: Record<string, unknown> | null;
  nexted: boolean;
}

const run = async (seller: PlanAccessStub | null): Promise<FakeCall> => {
  const call: FakeCall = { status: null, body: null, nexted: false };

  const req = {
    user: { id: 1, role: "SELLER", sellerId: 42 },
  } as any;

  const res = {
    status(code: number) {
      call.status = code;
      return res;
    },
    json(body: Record<string, unknown>) {
      call.body = body;
      return res;
    },
  } as any;

  const next = () => {
    call.nexted = true;
  };

  const middleware = requirePlanFeature("commerceWorkspace", {
    loadSeller: async () => seller,
  });

  await middleware(req, res, next);

  return call;
};

describe("requirePlanFeature free-access grant handling", () => {
  it("an admin-granted plan provides feature access after the trial has expired", async () => {
    const call = await run(
      makeSeller({
        trialPlan: "starter",
        trialEndsAt: daysFromNow(-3),
        freeAccessGrant: { plan: "starter", expiresAt: null, revokedAt: null },
      })
    );
    assert.equal(call.nexted, true);
    assert.equal(call.status, null);
  });

  it("a grant below the feature's minimum plan is rejected with PLAN_UPGRADE_REQUIRED", async () => {
    // advancedAnalytics requires pro; a starter grant is not enough.
    const call: FakeCall = { status: null, body: null, nexted: false };

    const req = { user: { id: 1, role: "SELLER", sellerId: 42 } } as any;
    const res = {
      status(code: number) {
        call.status = code;
        return res;
      },
      json(body: Record<string, unknown>) {
        call.body = body;
        return res;
      },
    } as any;

    const middleware = requirePlanFeature("advancedAnalytics", {
      loadSeller: async () =>
        makeSeller({
          freeAccessGrant: { plan: "starter", expiresAt: null, revokedAt: null },
        }),
    });

    await middleware(req, res, () => {
      call.nexted = true;
    });

    assert.equal(call.status, 403);
    assert.equal((call.body as any)?.code, "PLAN_UPGRADE_REQUIRED");
  });

  it("a pro grant unlocks a pro-gated feature", async () => {
    const call: FakeCall = { status: null, body: null, nexted: false };

    const req = { user: { id: 1, role: "SELLER", sellerId: 42 } } as any;
    const res = {
      status(code: number) {
        call.status = code;
        return res;
      },
      json(body: Record<string, unknown>) {
        call.body = body;
        return res;
      },
    } as any;

    const middleware = requirePlanFeature("advancedAnalytics", {
      loadSeller: async () =>
        makeSeller({
          trialPlan: "starter",
          trialEndsAt: daysFromNow(-10),
          freeAccessGrant: { plan: "pro", expiresAt: null, revokedAt: null },
        }),
    });

    await middleware(req, res, () => {
      call.nexted = true;
    });

    assert.equal(call.nexted, true);
    assert.equal(call.status, null);
  });

  it("a revoked grant provides no access", async () => {
    const call = await run(
      makeSeller({
        trialPlan: "starter",
        trialEndsAt: daysFromNow(-3),
        freeAccessGrant: {
          plan: "starter",
          expiresAt: null,
          revokedAt: daysFromNow(-1),
        },
      })
    );
    assert.equal(call.status, 403);
    assert.equal((call.body as any)?.code, "PLAN_REQUIRED");
  });

  it("an expired grant provides no access (server time, no cron)", async () => {
    const call = await run(
      makeSeller({
        freeAccessGrant: {
          plan: "business",
          expiresAt: daysFromNow(-1),
          revokedAt: null,
        },
      })
    );
    assert.equal(call.status, 403);
    assert.equal((call.body as any)?.code, "PLAN_REQUIRED");
  });

  it("a paid subscription is unaffected by grants and still grants access", async () => {
    const call = await run(
      makeSeller({
        activePlan: "starter",
        planStatus: "ACTIVE",
        planActivatedAt: daysFromNow(-1),
        planCurrentPeriodEnd: daysFromNow(30),
        freeAccessGrant: { plan: "business", expiresAt: null, revokedAt: null },
      })
    );
    assert.equal(call.nexted, true);
  });

  it("a seller without any entitlement is rejected", async () => {
    const call = await run(
      makeSeller({
        trialPlan: "starter",
        trialEndsAt: daysFromNow(-30),
      })
    );
    assert.equal(call.status, 403);
    assert.equal((call.body as any)?.code, "PLAN_REQUIRED");
  });
});
