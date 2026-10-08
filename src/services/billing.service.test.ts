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
