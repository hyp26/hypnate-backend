import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { getPlanAccess } from "./billing.service";

const daysFromNow = (days: number) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000);

describe("getPlanAccess paid/trial states", () => {
  it("PENDING never grants paid access (Case A)", () => {
    const access = getPlanAccess({
      activePlan: "starter",
      planStatus: "PENDING",
      planActivatedAt: daysFromNow(-1),
      planCurrentPeriodEnd: daysFromNow(10),
    });
    assert.equal(access.hasAccess, false);
    assert.notEqual(access.source, "paid");
  });

  it("CREATED checkout grants no access (Case B)", () => {
    const access = getPlanAccess({
      activePlan: null,
      planStatus: "CREATED",
      razorpaySubscriptionId: "sub_example",
    });
    assert.equal(access.hasAccess, false);
  });

  it("ACTIVE plan with a future period grants paid access (Case C)", () => {
    const access = getPlanAccess({
      activePlan: "starter",
      planStatus: "ACTIVE",
      planActivatedAt: daysFromNow(-1),
      planCurrentPeriodEnd: daysFromNow(30),
    });
    assert.equal(access.hasAccess, true);
    assert.equal(access.source, "paid");
    assert.equal(access.plan, "starter");
  });

  it("CANCELLED plan retains access until the paid period ends (Case D)", () => {
    const access = getPlanAccess({
      activePlan: "starter",
      planStatus: "CANCELLED",
      planActivatedAt: daysFromNow(-30),
      planCurrentPeriodEnd: daysFromNow(10),
    });
    assert.equal(access.hasAccess, true);
    assert.equal(access.source, "paid");
  });

  it("CANCELLED plan with a past or missing period loses access (Case E)", () => {
    const past = getPlanAccess({
      activePlan: "starter",
      planStatus: "CANCELLED",
      planActivatedAt: daysFromNow(-30),
      planCurrentPeriodEnd: daysFromNow(-1),
    });
    assert.equal(past.hasAccess, false);

    const noPeriod = getPlanAccess({
      activePlan: "starter",
      planStatus: "CANCELLED",
      planActivatedAt: daysFromNow(-30),
      planCurrentPeriodEnd: null,
    });
    assert.equal(noPeriod.hasAccess, false);
  });

  it("valid trial grants trial access (Case F)", () => {
    const access = getPlanAccess({
      activePlan: null,
      planStatus: "CREATED",
      trialPlan: "starter",
      trialEndsAt: daysFromNow(3),
    });
    assert.equal(access.hasAccess, true);
    assert.equal(access.source, "trial");
    assert.equal(access.plan, "starter");
  });

  it("expired trial grants no access (Case G)", () => {
    const access = getPlanAccess({
      activePlan: null,
      planStatus: "CREATED",
      trialPlan: "starter",
      trialEndsAt: daysFromNow(-3),
    });
    assert.equal(access.hasAccess, false);
  });
});

describe("getPlanAccess administrative free-access grants", () => {
  it("a valid grant provides access after the trial has expired", () => {
    const access = getPlanAccess({
      activePlan: null,
      planStatus: "NONE",
      trialPlan: "starter",
      trialEndsAt: daysFromNow(-3),
      freeAccessGrant: { plan: "starter", expiresAt: null, revokedAt: null },
    });
    assert.equal(access.hasAccess, true);
    assert.equal(access.source, "admin_grant");
    assert.equal(access.plan, "starter");
  });

  it("a grant can provide pro and business capabilities", () => {
    for (const plan of ["pro", "business"]) {
      const access = getPlanAccess({
        activePlan: null,
        planStatus: null,
        trialPlan: "starter",
        trialEndsAt: daysFromNow(-30),
        freeAccessGrant: { plan, expiresAt: null, revokedAt: null },
      });
      assert.equal(access.hasAccess, true);
      assert.equal(access.source, "admin_grant");
      assert.equal(access.plan, plan);
    }
  });

  it("an indefinite grant keeps providing access until revoked", () => {
    const access = getPlanAccess({
      activePlan: null,
      planStatus: null,
      trialPlan: null,
      trialEndsAt: null,
      freeAccessGrant: { plan: "pro", expiresAt: null, revokedAt: null },
    });
    assert.equal(access.hasAccess, true);
    assert.equal(access.source, "admin_grant");
    assert.equal(access.adminGrantExpiresAt ?? null, null);
  });

  it("a grant with a future expiration is valid now", () => {
    const expiresAt = daysFromNow(5);
    const access = getPlanAccess({
      freeAccessGrant: { plan: "starter", expiresAt, revokedAt: null },
    });
    assert.equal(access.hasAccess, true);
    assert.equal(access.source, "admin_grant");
    assert.equal(
      access.adminGrantExpiresAt ? access.adminGrantExpiresAt.getTime() : 0,
      expiresAt.getTime()
    );
  });

  it("an expired grant stops providing access based on server time", () => {
    const access = getPlanAccess({
      activePlan: null,
      planStatus: null,
      trialPlan: "starter",
      trialEndsAt: daysFromNow(-3),
      freeAccessGrant: {
        plan: "business",
        expiresAt: daysFromNow(-1),
        revokedAt: null,
      },
    });
    assert.equal(access.hasAccess, false);
    assert.equal(access.source, null);
  });

  it("a revoked grant provides no access", () => {
    const access = getPlanAccess({
      freeAccessGrant: {
        plan: "starter",
        expiresAt: null,
        revokedAt: daysFromNow(-1),
      },
    });
    assert.equal(access.hasAccess, false);
    assert.equal(access.source, null);
  });

  it("a valid paid subscription is never converted to or shadowed by a grant", () => {
    const access = getPlanAccess({
      activePlan: "starter",
      planStatus: "ACTIVE",
      planActivatedAt: daysFromNow(-1),
      planCurrentPeriodEnd: daysFromNow(30),
      freeAccessGrant: { plan: "business", expiresAt: null, revokedAt: null },
    });
    assert.equal(access.hasAccess, true);
    assert.equal(access.source, "paid");
    assert.equal(access.plan, "starter");
  });

  it("a suspended or inactive seller gains no access through a grant", () => {
    for (const status of ["SUSPENDED", "INACTIVE"]) {
      const access = getPlanAccess({
        status,
        freeAccessGrant: { plan: "business", expiresAt: null, revokedAt: null },
      });
      assert.equal(access.hasAccess, false);
      assert.equal(access.source, null);
    }
  });

  it("an invalid plan on a grant row is ignored (fail closed)", () => {
    const access = getPlanAccess({
      freeAccessGrant: { plan: "enterprise", expiresAt: null, revokedAt: null },
    });
    assert.equal(access.hasAccess, false);
  });

  it("the grant list form (freeAccessGrants) is also accepted", () => {
    const access = getPlanAccess({
      freeAccessGrants: [
        { plan: "pro", expiresAt: null, revokedAt: null },
      ],
    });
    assert.equal(access.hasAccess, true);
    assert.equal(access.source, "admin_grant");
    assert.equal(access.plan, "pro");
  });

  it("a grant does not resurrect a valid trial: trial still wins over expired grant, but valid grant wins over expired trial", () => {
    // Valid trial + expired grant => trial access.
    const trialAccess = getPlanAccess({
      trialPlan: "starter",
      trialEndsAt: daysFromNow(3),
      freeAccessGrant: {
        plan: "business",
        expiresAt: daysFromNow(-1),
        revokedAt: null,
      },
    });
    assert.equal(trialAccess.source, "trial");
  });

  it("sellers without grant state behave exactly as before", () => {
    const access = getPlanAccess({
      activePlan: "starter",
      planStatus: "ACTIVE",
      planActivatedAt: daysFromNow(-1),
      planCurrentPeriodEnd: daysFromNow(30),
    });
    assert.equal(access.source, "paid");
  });
});
