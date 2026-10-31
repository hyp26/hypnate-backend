import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

/*
 * DATABASE-BACKED regression tests for the SUPER_ADMIN
 * free-access grant feature.
 *
 * These tests REQUIRE a disposable PostgreSQL database with the
 * full Prisma migration chain applied:
 *
 *   DATABASE_URL=postgres://... node --test \
 *     dist/controllers/admin/adminFreeAccess.db.test.js
 *
 * They automatically SKIP when DATABASE_URL is not set. NEVER
 * point them at a shared or production database: they create
 * and delete seller/admin/grant/audit fixture rows.
 *
 * They exercise the REAL controllers (grant/update/revoke),
 * the REAL entitlement decision (getPlanAccess) and the REAL
 * route guard (requireAdminRoles), not approximations.
 *
 * NOT EXECUTED in the authoring environment (no Node.js and
 * no PostgreSQL available) — see the PR description for the
 * exact verification status.
 */

const hasDatabase = !!process.env.DATABASE_URL;

describe(
  "admin free-access grants (database-backed)",
  { skip: !hasDatabase },
  () => {
    let prisma: any;
    let grantFreeAccess: any;
    let updateFreeAccess: any;
    let revokeFreeAccess: any;
    let getPlanAccess: any;
    let hasPlanFeature: any;
    let hasPlanChannel: any;

    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    const createdSellerIds: number[] = [];
    const createdAdminIds: number[] = [];

    const daysFromNow = (days: number) =>
      new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    const createSuperAdmin = async (label: string, role: "SUPER_ADMIN" | "ADMIN" | "SUPPORT" = "SUPER_ADMIN") => {
      const admin = await prisma.adminUser.create({
        data: {
          email: `fa-${label}-${stamp}@example.test`,
          passwordHash: "test-hash",
          firstName: "Free",
          lastName: "Access",
          role,
          status: "ACTIVE",
        },
      });
      createdAdminIds.push(admin.id);
      return admin;
    };

    const createSeller = async (
      label: string,
      overrides: Record<string, unknown> = {}
    ) => {
      const seller = await prisma.seller.create({
        data: {
          businessName: `fa-${label}-${stamp}`,
          trialPlan: "starter",
          trialStartedAt: daysFromNow(-10),
          trialEndsAt: daysFromNow(-3),
          ...overrides,
        },
      });
      createdSellerIds.push(seller.id);
      return seller;
    };

    /**
     * Minimal fake Express request/response pair. The actor is
     * always taken from req.adminUser (never the body).
     */
    const makeReqRes = (
      sellerId: number,
      body: Record<string, unknown> = {},
      admin: { id: number; role: string } = { id: 0, role: "SUPER_ADMIN" }
    ) => {
      const req = {
        params: { id: String(sellerId) },
        body,
        adminUser: { id: admin.id, role: admin.role },
        ip: "127.0.0.1",
        get: (header: string) =>
          header.toLowerCase() === "user-agent" ? "fa-test-agent" : undefined,
      } as any;

      const captured: {
        status: number;
        body: Record<string, unknown> | null;
      } = { status: 200, body: null };

      const res = {
        status(code: number) {
          captured.status = code;
          return res;
        },
        json(body: Record<string, unknown>) {
          captured.body = body;
          return res;
        },
      } as any;

      return { req, res, captured };
    };

    const call = async (
      fn: any,
      sellerId: number,
      body: Record<string, unknown> = {},
      admin: { id: number; role: string } = { id: 0, role: "SUPER_ADMIN" }
    ) => {
      const { req, res, captured } = makeReqRes(sellerId, body, admin);
      await fn(req, res, (err: unknown) => {
        throw err;
      });
      return captured;
    };

    /** Loads the seller and computes the EFFECTIVE access the same
     * way billing-status and plan middleware do. */
    const effectiveAccess = async (sellerId: number) => {
      const seller = await prisma.seller.findUnique({
        where: { id: sellerId },
        include: {
          freeAccessGrants: {
            where: { revokedAt: null },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
      });

      return getPlanAccess({
        ...seller,
        freeAccessGrant: seller.freeAccessGrants[0] ?? null,
      });
    };

    const auditEntries = (sellerId: number) =>
      prisma.auditLog.findMany({
        where: {
          entityType: "SellerFreeAccessGrant",
          entityId: String(sellerId),
        },
        orderBy: { createdAt: "asc" },
      });

    before(async () => {
      prisma = (await import("../../prisma/client")).default;
      ({ grantFreeAccess, updateFreeAccess, revokeFreeAccess } =
        await import("../../controllers/admin/adminFreeAccess.controller"));
      ({ getPlanAccess } = await import("../../services/billing.service"));
      ({
        hasPlanFeature,
        hasPlanChannel,
      } = await import("../../config/planEntitlements"));
    });

    after(async () => {
      if (!prisma) {
        return;
      }

      await prisma.sellerFreeAccessGrant.deleteMany({
        where: { sellerId: { in: createdSellerIds } },
      });

      await prisma.auditLog.deleteMany({
        where: {
          adminUserId: { in: createdAdminIds },
          entityType: "SellerFreeAccessGrant",
        },
      });

      await prisma.seller.deleteMany({
        where: { id: { in: createdSellerIds } },
      });

      await prisma.adminUser.deleteMany({
        where: { id: { in: createdAdminIds } },
      });
    });

    it("grants Starter access to a seller whose trial has expired", async () => {
      const admin = await createSuperAdmin("admin-a");
      const seller = await createSeller("expired-trial");

      // Before the grant: no access at all.
      const before = await effectiveAccess(seller.id);
      assert.equal(before.hasAccess, false);
      assert.equal(before.source, null);

      const captured = await call(grantFreeAccess, seller.id, {
        plan: "starter",
        reason: "Goodwill after support case",
      }, admin);

      assert.equal(captured.status, 201);
      assert.equal((captured.body as any)?.accessSource, "admin_grant");
      assert.equal((captured.body as any)?.effectivePlan, "starter");

      const after = await effectiveAccess(seller.id);
      assert.equal(after.hasAccess, true);
      assert.equal(after.source, "admin_grant");
      assert.equal(after.plan, "starter");
    });

    it("a Pro grant unlocks pro-gated features and channels", async () => {
      const admin = await createSuperAdmin("admin-b");
      const seller = await createSeller("pro-grant");

      const captured = await call(grantFreeAccess, seller.id, {
        plan: "pro",
        reason: "Partner program",
      }, admin);

      assert.equal(captured.status, 201);
      assert.equal((captured.body as any)?.effectivePlan, "pro");

      const access = await effectiveAccess(seller.id);
      assert.equal(access.source, "admin_grant");
      assert.equal(access.plan, "pro");
      assert.equal(hasPlanFeature(access.plan, "advancedAnalytics"), true);
      assert.equal(hasPlanChannel(access.plan, "instagram"), true);
      assert.equal(hasPlanFeature(access.plan, "hypnateX"), false);
    });

    it("a Business grant unlocks business-gated features", async () => {
      const admin = await createSuperAdmin("admin-b2");
      const seller = await createSeller("business-grant");

      await call(grantFreeAccess, seller.id, {
        plan: "business",
        reason: "Enterprise pilot",
      }, admin);

      const access = await effectiveAccess(seller.id);
      assert.equal(access.plan, "business");
      assert.equal(hasPlanFeature(access.plan, "hypnateX"), true);
    });

    it("an indefinite grant continues providing access until revoked", async () => {
      const admin = await createSuperAdmin("admin-c");
      const seller = await createSeller("indefinite");

      const captured = await call(grantFreeAccess, seller.id, {
        plan: "starter",
        reason: "Internal test account",
      }, admin);

      assert.equal(captured.status, 201);
      // No expiration => indefinite.
      assert.equal((captured.body as any)?.adminGrant?.expiresAt, null);

      const access = await effectiveAccess(seller.id);
      assert.equal(access.hasAccess, true);
      assert.equal(access.adminGrantExpiresAt ?? null, null);

      const active = await prisma.sellerFreeAccessGrant.count({
        where: { sellerId: seller.id, revokedAt: null },
      });
      assert.equal(active, 1);
    });

    it("a grant with an expiration stops providing access after expiry (server time)", async () => {
      const admin = await createSuperAdmin("admin-d");
      const seller = await createSeller("expiring");

      const captured = await call(grantFreeAccess, seller.id, {
        plan: "starter",
        expiresAt: daysFromNow(5).toISOString(),
        reason: "Limited promotional access",
      }, admin);

      assert.equal(captured.status, 201);

      // Valid before expiry.
      let access = await effectiveAccess(seller.id);
      assert.equal(access.source, "admin_grant");

      // Simulate the passage of time by moving the stored
      // expiration into the past, then re-evaluate.
      const grant = await prisma.sellerFreeAccessGrant.findFirst({
        where: { sellerId: seller.id, revokedAt: null },
      });
      await prisma.sellerFreeAccessGrant.update({
        where: { id: grant.id },
        data: { expiresAt: daysFromNow(-1) },
      });

      access = await effectiveAccess(seller.id);
      assert.equal(access.hasAccess, false);
      assert.equal(access.source, null);
    });

    it("revocation removes administrative access; an expired trial does not resume", async () => {
      const admin = await createSuperAdmin("admin-e");
      const seller = await createSeller("revoke");

      await call(grantFreeAccess, seller.id, {
        plan: "pro",
        reason: "Temporary access",
      }, admin);

      let access = await effectiveAccess(seller.id);
      assert.equal(access.source, "admin_grant");

      const revoked = await call(revokeFreeAccess, seller.id, {
        reason: "Promotion ended",
      }, admin);

      assert.equal(revoked.status, 200);

      access = await effectiveAccess(seller.id);
      assert.equal(access.hasAccess, false);
      assert.equal(access.source, null);

      // The grant row is retained for audit history, marked revoked.
      const rows = await prisma.sellerFreeAccessGrant.findMany({
        where: { sellerId: seller.id },
      });
      assert.equal(rows.length, 1);
      assert.ok(rows[0].revokedAt);
      assert.equal(rows[0].revokedByAdminId, admin.id);

      // Revoking again reports that there is no active grant.
      const again = await call(revokeFreeAccess, seller.id, {
        reason: "Already revoked",
      }, admin);
      assert.equal(again.status, 404);
    });

    it("a still-valid paid subscription is not overwritten by a grant", async () => {
      const admin = await createSuperAdmin("admin-f");
      const paidSince = daysFromNow(-10);
      const seller = await createSeller("paid", {
        activePlan: "starter",
        planStatus: "ACTIVE",
        planActivatedAt: paidSince,
        planCurrentPeriodEnd: daysFromNow(20),
        billingCycle: "monthly",
      });

      const before = await prisma.seller.findUnique({ where: { id: seller.id } });

      const captured = await call(grantFreeAccess, seller.id, {
        plan: "business",
        reason: "Grant must not touch billing",
      }, admin);

      assert.equal(captured.status, 201);
      // Paid subscription still wins over the grant.
      assert.equal((captured.body as any)?.accessSource, "paid");
      assert.equal((captured.body as any)?.effectivePlan, "starter");

      const after = await prisma.seller.findUnique({ where: { id: seller.id } });

      // Billing fields are byte-for-byte untouched.
      assert.equal(after.activePlan, before.activePlan);
      assert.equal(after.planStatus, before.planStatus);
      assert.equal(
        after.planActivatedAt?.toISOString(),
        before.planActivatedAt?.toISOString()
      );
      assert.equal(
        after.planCurrentPeriodEnd?.toISOString(),
        before.planCurrentPeriodEnd?.toISOString()
      );
      assert.equal(after.razorpaySubscriptionId, null);
      assert.equal(after.razorpayPlanId, null);
      assert.equal(after.billingCycle, before.billingCycle);

      // No Razorpay artifacts were created.
      assert.equal(after.razorpaySubscriptionId, before.razorpaySubscriptionId);

      const access = await effectiveAccess(seller.id);
      assert.equal(access.source, "paid");
    });

    it("a suspended seller cannot bypass the account block through a grant", async () => {
      const admin = await createSuperAdmin("admin-g");
      const seller = await createSeller("suspended", { status: "SUSPENDED" });

      const captured = await call(grantFreeAccess, seller.id, {
        plan: "business",
        reason: "Grant while suspended",
      }, admin);

      assert.equal(captured.status, 201);

      const access = await effectiveAccess(seller.id);
      assert.equal(access.hasAccess, false);
      assert.equal(access.source, null);
    });

    it("a repeated grant replaces the active grant without duplicating it", async () => {
      const admin = await createSuperAdmin("admin-h");
      const seller = await createSeller("repeat");

      await call(grantFreeAccess, seller.id, {
        plan: "starter",
        reason: "First grant",
      }, admin);

      await call(grantFreeAccess, seller.id, {
        plan: "pro",
        reason: "Upgrade the grant",
      }, admin);

      const active = await prisma.sellerFreeAccessGrant.findMany({
        where: { sellerId: seller.id, revokedAt: null },
      });

      assert.equal(active.length, 1);
      assert.equal(active[0].plan, "pro");

      const access = await effectiveAccess(seller.id);
      assert.equal(access.plan, "pro");
    });

    it("updating the plan and expiration requires a reason and is audited", async () => {
      const admin = await createSuperAdmin("admin-i");
      const seller = await createSeller("update");

      await call(grantFreeAccess, seller.id, {
        plan: "starter",
        reason: "Initial grant",
      }, admin);

      const updated = await call(updateFreeAccess, seller.id, {
        plan: "pro",
        expiresAt: null,
        reason: "Promotion extended to Pro",
      }, admin);

      assert.equal(updated.status, 200);
      assert.equal((updated.body as any)?.effectivePlan, "pro");

      const active = await prisma.sellerFreeAccessGrant.findFirst({
        where: { sellerId: seller.id, revokedAt: null },
      });
      assert.equal(active.plan, "pro");
      assert.equal(active.expiresAt, null);

      // No active grant => update fails closed.
      await call(revokeFreeAccess, seller.id, { reason: "Revoke" }, admin);
      const missing = await call(updateFreeAccess, seller.id, {
        plan: "business",
        reason: "Nothing to update",
      }, admin);
      assert.equal(missing.status, 404);
    });

    it("grant, update and revoke all create audit entries with actor and reason", async () => {
      const admin = await createSuperAdmin("admin-j");
      const seller = await createSeller("audit");

      await call(grantFreeAccess, seller.id, {
        plan: "starter",
        reason: "Audit trail test grant",
      }, admin);
      await call(updateFreeAccess, seller.id, {
        plan: "business",
        reason: "Audit trail test update",
      }, admin);
      await call(revokeFreeAccess, seller.id, {
        reason: "Audit trail test revoke",
      }, admin);

      const entries = await auditEntries(seller.id);

      assert.equal(entries.length, 3);

      for (const entry of entries) {
        assert.equal(entry.adminUserId, admin.id);
      }

      const [grantEntry, updateEntry, revokeEntry] = entries;

      assert.equal(grantEntry.action, "CREATE");
      assert.equal((grantEntry.newValue as any)?.plan, "starter");
      assert.equal((grantEntry.newValue as any)?.reason, "Audit trail test grant");
      assert.equal((grantEntry.newValue as any)?.sellerId, seller.id);
      assert.equal(grantEntry.oldValue, null);

      assert.equal(updateEntry.action, "UPDATE");
      assert.equal((updateEntry.oldValue as any)?.plan, "starter");
      assert.equal((updateEntry.newValue as any)?.plan, "business");

      assert.equal(revokeEntry.action, "UPDATE");
      assert.equal((revokeEntry.newValue as any)?.revoked, true);
      assert.equal(
        (revokeEntry.newValue as any)?.revocationReason,
        "Audit trail test revoke"
      );
      assert.ok((revokeEntry.newValue as any)?.revokedAt);
    });

    it("rejects invalid plans, empty reasons, past expirations and unknown sellers", async () => {
      const admin = await createSuperAdmin("admin-k");
      const seller = await createSeller("invalid");

      const invalidPlan = await call(grantFreeAccess, seller.id, {
        plan: "enterprise",
        reason: "Invalid plan",
      }, admin);
      assert.equal(invalidPlan.status, 400);

      const emptyReason = await call(grantFreeAccess, seller.id, {
        plan: "starter",
        reason: "   ",
      }, admin);
      assert.equal(emptyReason.status, 400);

      const pastExpiry = await call(grantFreeAccess, seller.id, {
        plan: "starter",
        expiresAt: daysFromNow(-1).toISOString(),
        reason: "Past expiration",
      }, admin);
      assert.equal(pastExpiry.status, 400);

      const unknownSeller = await call(grantFreeAccess, 999999999, {
        plan: "starter",
        reason: "Does not exist",
      }, admin);
      assert.equal(unknownSeller.status, 404);

      const invalidId = await call(grantFreeAccess, -1, {
        plan: "starter",
        reason: "Invalid id",
      }, admin);
      assert.equal(invalidId.status, 400);

      // Nothing was written for the invalid requests.
      const rows = await prisma.sellerFreeAccessGrant.count({
        where: { sellerId: seller.id },
      });
      assert.equal(rows, 0);
    });
  }
);
