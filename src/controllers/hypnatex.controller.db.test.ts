import "dotenv/config";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

/**
 * DATABASE-BACKED REGRESSION TESTS — HypnateX Store Ownership
 *
 * Requirements:
 * - Disposable PostgreSQL database
 * - Full Prisma migration chain applied
 *
 * Run after compiling:
 *   node --test dist/controllers/hypnatex.controller.db.test.js
 *
 * Tests skip automatically when DATABASE_URL is not set.
 *
 * WARNING:
 * These tests create and delete test sellers, stores and build jobs.
 * NEVER point DATABASE_URL at production or a shared database.
 */

const hasDatabase = !!process.env.DATABASE_URL;

describe(
  "HypnateX store ownership (database-backed)",
  { skip: !hasDatabase },
  () => {
    let prisma: any;
    let startBuild: any;
    let updateStore: any;

    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    const createdSellerIds: number[] = [];
    const createdStoreIds: number[] = [];
    const createdBuildJobIds: number[] = [];
    const createdThemeIds: string[] = [];

    const createSeller = async (label: string) => {
      const seller = await prisma.seller.create({
        data: {
          businessName: `hx-test-${label}-${stamp}`,
        },
      });

      createdSellerIds.push(seller.id);
      return seller;
    };

    const createTheme = async () => {
      const theme = await prisma.theme.create({
        data: {
          id: `hx-test-${randomUUID()}`,
          name: `HypnateX Test ${stamp}`,
          category: "TEST",
          previewBg: "#ffffff",
          accentColor: "#000000",
          layout: "test",
          tags: ["test"],
          active: true,
        },
      });

      createdThemeIds.push(theme.id);
      return theme;
    };

    const createStore = async (
      sellerId: number,
      themeId: string,
      slug: string
    ) => {
      const store = await prisma.store.create({
        data: {
          sellerId,
          themeId,
          storeName: `Test Store ${stamp}`,
          slug,
          status: "BUILDING",
        },
      });

      createdStoreIds.push(store.id);
      return store;
    };

    const createBuildJob = async (
      storeId: number,
      sellerId: number,
      themeId: string
    ) => {
      const job = await prisma.buildJob.create({
        data: {
          storeId,
          sellerId,
          themeId,
          storeName: `Test Store ${stamp}`,
          status: "QUEUED",
          currentStep: "Test",
        },
      });

      createdBuildJobIds.push(job.id);
      return job;
    };

    const makeReqRes = (
      sellerId: number,
      body: Record<string, unknown> = {}
    ) => {
      const req = {
        user: { sellerId },
        body,
        params: {},
      } as any;

      const captured: {
        status: number;
        body: any;
      } = {
        status: 200,
        body: null,
      };

      const res = {
        status(code: number) {
          captured.status = code;
          return res;
        },
        json(body: any) {
          captured.body = body;
          return res;
        },
      } as any;

      return { req, res, captured };
    };

    const callController = async (
      controller: any,
      sellerId: number,
      body: Record<string, unknown> = {}
    ) => {
      const { req, res, captured } = makeReqRes(sellerId, body);

      let controllerError: unknown;

      await controller(req, res, (error: unknown) => {
        controllerError = error;
      });

      if (controllerError) {
        throw controllerError;
      }

      return captured;
    };

    before(async () => {
      prisma = (await import("../prisma/client")).default;

      const controller = await import("./hypnatex.controller");

      startBuild = controller.startBuild;
      updateStore = controller.updateStore;
    });

    after(async () => {
      if (!prisma) return;

      // Delete dependent rows before parent rows.
      if (createdBuildJobIds.length) {
        await prisma.buildJob.deleteMany({
          where: { id: { in: createdBuildJobIds } },
        });
      }

      if (createdStoreIds.length) {
        await prisma.store.deleteMany({
          where: { id: { in: createdStoreIds } },
        });
      }

      if (createdThemeIds.length) {
        await prisma.theme.deleteMany({
          where: { id: { in: createdThemeIds } },
        });
      }

      if (createdSellerIds.length) {
        await prisma.seller.deleteMany({
          where: { id: { in: createdSellerIds } },
        });
      }

      await prisma.$disconnect();
    });

    it("does not reuse a base slug owned by another seller", async () => {
      const sellerA = await createSeller("slug-a");
      const sellerB = await createSeller("slug-b");
      const theme = await createTheme();

      const baseSlug = `shared-${stamp}`;

      const existingStore = await createStore(
        sellerA.id,
        theme.id,
        baseSlug
      );

      const response = await callController(
        startBuild,
        sellerB.id,
        {
          themeId: theme.id,
          storeName: baseSlug,
        }
      );

      assert.equal(response.status, 202);
      assert.notEqual(response.body.slug, baseSlug);

      const persistedStore = await prisma.store.findUnique({
        where: { slug: baseSlug },
      });

      assert.equal(persistedStore.sellerId, sellerA.id);
      assert.equal(persistedStore.id, existingStore.id);

      const newStore = await prisma.store.findUnique({
        where: { slug: response.body.slug },
      });

      assert.ok(newStore);
      assert.equal(newStore.sellerId, sellerB.id);

      createdStoreIds.push(newStore.id);

      const job = await prisma.buildJob.findUnique({
        where: { id: response.body.jobId },
      });

      assert.ok(job);
      createdBuildJobIds.push(job.id);
      assert.equal(job.sellerId, sellerB.id);
      assert.equal(job.storeId, newStore.id);
    });

    it("continues to another candidate when the seller fallback slug is occupied", async () => {
      const sellerA = await createSeller("fallback-a");
      const sellerB = await createSeller("fallback-b");
      const theme = await createTheme();

      const baseSlug = `fallback-${stamp}`;
      const sellerFallbackSlug = `${baseSlug}-${sellerB.id}`;

      await createStore(sellerA.id, theme.id, baseSlug);
      const fallbackStore = await createStore(
        sellerA.id,
        theme.id,
        sellerFallbackSlug
      );

      const response = await callController(
        startBuild,
        sellerB.id,
        {
          themeId: theme.id,
          storeName: baseSlug,
        }
      );

      assert.equal(response.status, 202);
      assert.notEqual(response.body.slug, baseSlug);
      assert.notEqual(response.body.slug, sellerFallbackSlug);

      const unchangedFallback = await prisma.store.findUnique({
        where: { id: fallbackStore.id },
      });

      assert.equal(unchangedFallback.sellerId, sellerA.id);
      assert.equal(unchangedFallback.slug, sellerFallbackSlug);

      const newStore = await prisma.store.findUnique({
        where: { slug: response.body.slug },
      });

      assert.ok(newStore);
      assert.equal(newStore.sellerId, sellerB.id);

      createdStoreIds.push(newStore.id);
      createdBuildJobIds.push(response.body.jobId);
    });

    it("creates distinct stores when two sellers build with the same name concurrently", async () => {
      const sellerA = await createSeller("concurrent-a");
      const sellerB = await createSeller("concurrent-b");
      const theme = await createTheme();

      const storeName = `Concurrent ${stamp}`;

      const responses = await Promise.all([
        callController(startBuild, sellerA.id, {
          themeId: theme.id,
          storeName,
        }),
        callController(startBuild, sellerB.id, {
          themeId: theme.id,
          storeName,
        }),
      ]);

      assert.equal(responses[0].status, 202);
      assert.equal(responses[1].status, 202);

      assert.notEqual(
        responses[0].body.slug,
        responses[1].body.slug
      );

      const stores = await prisma.store.findMany({
        where: {
          slug: {
            in: responses.map((response) => response.body.slug),
          },
        },
      });

      assert.equal(stores.length, 2);

      assert.deepEqual(
        stores.map((store: any) => store.sellerId).sort(),
        [sellerA.id, sellerB.id].sort()
      );

      const jobs = await prisma.buildJob.findMany({
        where: {
          id: {
            in: responses.map((response) => response.body.jobId),
          },
        },
      });

      assert.equal(jobs.length, 2);

      for (const store of stores) {
        createdStoreIds.push(store.id);
      }

      for (const job of jobs) {
        createdBuildJobIds.push(job.id);
      }
    });

    it("allows only one active build for concurrent requests from the same seller", async () => {
      const seller = await createSeller("same-seller");
      const theme = await createTheme();

      const storeName = `Same Seller ${stamp}`;

      const responses = await Promise.all([
        callController(startBuild, seller.id, {
          themeId: theme.id,
          storeName,
        }),
        callController(startBuild, seller.id, {
          themeId: theme.id,
          storeName,
        }),
      ]);

      const accepted = responses.filter(
        (response) => response.status === 202
      );

      const rejected = responses.filter(
        (response) => response.status === 409
      );

      assert.equal(accepted.length, 1);
      assert.equal(rejected.length, 1);

      const activeJobs = await prisma.buildJob.findMany({
        where: {
          sellerId: seller.id,
          status: {
            notIn: ["DONE", "FAILED"],
          },
        },
      });

      assert.equal(activeJobs.length, 1);

      const stores = await prisma.store.findMany({
        where: { sellerId: seller.id },
      });

      assert.equal(stores.length, 1);

      createdStoreIds.push(...stores.map((store: any) => store.id));
      createdBuildJobIds.push(...activeJobs.map((job: any) => job.id));
    });

    it("rejects a BuildJob whose seller does not own the referenced store", async () => {
      const sellerA = await createSeller("fk-a");
      const sellerB = await createSeller("fk-b");
      const theme = await createTheme();

      const store = await createStore(
        sellerA.id,
        theme.id,
        `fk-${stamp}`
      );

      await assert.rejects(
        () =>
          createBuildJob(
            store.id,
            sellerB.id,
            theme.id
          ),
        (error: any) => {
          assert.equal(error.code, "P2003");
          return true;
        }
      );
    });

    it("updates only the authenticated seller's store", async () => {
      const sellerA = await createSeller("update-a");
      const sellerB = await createSeller("update-b");
      const theme = await createTheme();

      const storeA = await createStore(
        sellerA.id,
        theme.id,
        `update-a-${stamp}`
      );

      const storeB = await createStore(
        sellerB.id,
        theme.id,
        `update-b-${stamp}`
      );

      const response = await callController(
        updateStore,
        sellerA.id,
        {
          storeName: "Updated by Seller A",
        }
      );

      assert.equal(response.status, 200);

      const updatedA = await prisma.store.findUnique({
        where: { id: storeA.id },
      });

      const unchangedB = await prisma.store.findUnique({
        where: { id: storeB.id },
      });

      assert.equal(updatedA.storeName, "Updated by Seller A");
      assert.equal(unchangedB.storeName, `Test Store ${stamp}`);
      assert.equal(unchangedB.sellerId, sellerB.id);
    });
  }
);
