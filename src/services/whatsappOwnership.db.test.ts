import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

/*
 * DATABASE-BACKED ownership invariant tests (audit finding H-3).
 *
 * These tests REQUIRE a disposable PostgreSQL database with the
 * full Prisma migration chain applied:
 *
 *   DATABASE_URL=postgres://... node --test \
 *     dist/services/whatsappOwnership.db.test.js
 *
 * They automatically SKIP when DATABASE_URL is not set. NEVER
 * point them at a shared or production database: they create and
 * delete seller/connection/ownership fixture rows.
 *
 * NOT EXECUTED in the authoring environment (no Node.js and no
 * PostgreSQL available) — see the PR description for the exact
 * verification status.
 */

const hasDatabase = !!process.env.DATABASE_URL;

describe(
  "whatsappOwnership database-backed invariants (H-3)",
  { skip: !hasDatabase },
  () => {
    let prisma: any;
    let syncConnectionOwnership: any;

    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    const createdSellerIds: number[] = [];
    const createdConnectionIds: number[] = [];

    const createSeller = async (label: string) => {
      const seller = await prisma.seller.create({
        data: {
          businessName: `h3-test-${label}-${stamp}`,
        },
      });

      createdSellerIds.push(seller.id);

      return seller;
    };

    const createWhatsAppConnection = async (
      sellerId: number,
      metadata: Record<string, unknown>
    ) => {
      const connection = await prisma.channelConnection.create({
        data: {
          sellerId,
          platform: "WHATSAPP",
          name: `test-${stamp}`,
          accessToken: "test-placeholder",
          metadata,
          isActive: true,
        },
      });

      createdConnectionIds.push(connection.id);

      return connection;
    };

    before(async () => {
      prisma = (await import("../prisma/client")).default;
      (
        {
          syncConnectionOwnership,
        } = await import("./whatsappOwnership.service")
      );
    });

    after(async () => {
      if (!prisma) {
        return;
      }

      // Ownership rows reference connections; delete them first.
      await prisma.whatsAppPhoneOwnership.deleteMany({
        where: {
          connectionId: { in: createdConnectionIds },
        },
      });

      await prisma.channelConnection.deleteMany({
        where: {
          id: { in: createdConnectionIds },
        },
      });

      await prisma.seller.deleteMany({
        where: {
          id: { in: createdSellerIds },
        },
      });
    });

    it("rejects a cross-seller OAuth claim to an actively owned number and rolls back the whole transaction", async () => {
      const sellerA = await createSeller("a");
      const sellerB = await createSeller("b");

      const connectionA = await createWhatsAppConnection(
        sellerA.id,
        { phoneNumberIds: ["111000"] }
      );

      // Seller A's ownership, created via the guarded sync.
      await prisma.$transaction(async (tx: any) => {
        await syncConnectionOwnership(
          tx,
          {
            id: connectionA.id,
            sellerId: sellerA.id,
            metadata: { phoneNumberIds: ["111000"] },
          },
          "WABA-A"
        );
      });

      // Seller B's OAuth callback pattern: connection upsert AND
      // ownership sync in ONE transaction. It must abort entirely.
      await assert.rejects(
        prisma.$transaction(async (tx: any) => {
          await tx.channelConnection.upsert({
            where: {
              sellerId_platform: {
                sellerId: sellerB.id,
                platform: "WHATSAPP",
              },
            },
            create: {
              sellerId: sellerB.id,
              platform: "WHATSAPP",
              name: "b",
              accessToken: "test-placeholder",
              externalAccountId: "WABA-B",
              metadata: { phoneNumberIds: ["111000"] },
              isActive: true,
            },
            update: {
              externalAccountId: "WABA-B",
              metadata: { phoneNumberIds: ["111000"] },
              isActive: true,
            },
          });

          const connectionB =
            await tx.channelConnection.findFirst({
              where: {
                sellerId: sellerB.id,
                platform: "WHATSAPP",
              },
            });

          await syncConnectionOwnership(
            tx,
            {
              id: connectionB.id,
              sellerId: sellerB.id,
              metadata: { phoneNumberIds: ["111000"] },
            },
            "WABA-B"
          );
        })
      );

      // Seller A's mapping is unchanged and remains the only
      // active owner.
      const activeRows =
        await prisma.whatsAppPhoneOwnership.findMany({
          where: { phoneNumberId: "111000", isActive: true },
        });

      assert.equal(activeRows.length, 1);
      assert.equal(activeRows[0].connectionId, connectionA.id);
      assert.equal(activeRows[0].sellerId, sellerA.id);
    });

    it("preserves valid ownership on a same-seller, same-connection reconnect", async () => {
      const seller = await createSeller("c");
      const connection = await createWhatsAppConnection(seller.id, {
        phoneNumberIds: ["222000"],
      });

      await prisma.$transaction(async (tx: any) => {
        await syncConnectionOwnership(
          tx,
          {
            id: connection.id,
            sellerId: seller.id,
            metadata: { phoneNumberIds: ["222000"] },
          },
          "WABA-C"
        );
      });

      // Reconnect with identical claims succeeds and does not
      // duplicate the active row.
      await prisma.$transaction(async (tx: any) => {
        await syncConnectionOwnership(
          tx,
          {
            id: connection.id,
            sellerId: seller.id,
            metadata: { phoneNumberIds: ["222000"] },
          },
          "WABA-C"
        );
      });

      const activeRows =
        await prisma.whatsAppPhoneOwnership.findMany({
          where: { phoneNumberId: "222000", isActive: true },
        });

      assert.equal(activeRows.length, 1);
      assert.equal(activeRows[0].connectionId, connection.id);
    });

    it("lets exactly one of two concurrent claims win; the loser aborts without splitting ownership", async () => {
      const sellerA = await createSeller("d");
      const sellerB = await createSeller("e");

      const connectionA = await createWhatsAppConnection(sellerA.id, {
        phoneNumberIds: ["333000"],
      });
      const connectionB = await createWhatsAppConnection(sellerB.id, {
        phoneNumberIds: ["333000"],
      });

      const claim = (connection: any, sellerId: number) =>
        prisma.$transaction(async (tx: any) => {
          await syncConnectionOwnership(
            tx,
            {
              id: connection.id,
              sellerId,
              metadata: { phoneNumberIds: ["333000"] },
            },
            "WABA-D"
          );
        });

      const results = await Promise.allSettled([
        claim(connectionA, sellerA.id),
        claim(connectionB, sellerB.id),
      ]);

      // At least one succeeded; at most one succeeded.
      const succeeded = results.filter(
        (result) => result.status === "fulfilled"
      );

      assert.ok(succeeded.length >= 1);
      assert.equal(succeeded.length, 1);

      // Exactly one active owner exists afterwards.
      const activeRows =
        await prisma.whatsAppPhoneOwnership.findMany({
          where: { phoneNumberId: "333000", isActive: true },
        });

      assert.equal(activeRows.length, 1);
    });
  }
);
