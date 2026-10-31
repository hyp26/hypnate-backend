
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const hasDatabase = !!process.env.DATABASE_URL;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe(
  "getMessages tenant isolation (Finding 2)",
  { skip: !hasDatabase },
  () => {
    let prisma: any;
    let getMessages: any;
    let acquirePhoneNumberLock: any;
    let syncConnectionOwnership: any;

    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    const sellerIds: number[] = [];
    const connectionIds: number[] = [];
    const conversationIds: number[] = [];

    const createSeller = async (label: string) => {
      const seller = await prisma.seller.create({
        data: { businessName: `f2-${label}-${stamp}` },
      });

      sellerIds.push(seller.id);
      return seller;
    };

    const createConnection = async (
      sellerId: number,
      phoneNumberId: string
    ) => {
      const connection = await prisma.channelConnection.create({
        data: {
          sellerId,
          platform: "WHATSAPP",
          name: `f2-${stamp}`,
          accessToken: "test-placeholder",
          metadata: { phoneNumberIds: [phoneNumberId] },
          isActive: true,
        },
      });

      connectionIds.push(connection.id);
      return connection;
    };

    const establishOwnership = async (
      connection: any,
      sellerId: number,
      phoneNumberId: string
    ) => {
      await prisma.$transaction(async (tx: any) => {
        await syncConnectionOwnership(
          tx,
          {
            id: connection.id,
            sellerId,
            metadata: { phoneNumberIds: [phoneNumberId] },
          },
          `WABA-${stamp}`
        );
      });
    };

    const createConversation = async (
      sellerId: number,
      phoneNumberId: string,
      platform = "WHATSAPP"
    ) => {
      const conversation = await prisma.conversation.create({
        data: {
          sellerId,
          platform,
          customerName: `f2-customer-${stamp}`,
          externalUserId: `f2-user-${stamp}`,
          externalThreadId:
            platform === "WHATSAPP" ? phoneNumberId : null,
          unreadCount: 1,
        },
      });

      conversationIds.push(conversation.id);
      return conversation;
    };

    const createUnreadMessage = async (conversationId: number) => {
      return prisma.message.create({
        data: {
          conversationId,
          sender: "CUSTOMER",
          direction: "INBOUND",
          text: `f2-message-${stamp}`,
          isRead: false,
        },
      });
    };

    const invokeGetMessages = async (
      conversationId: number,
      sellerId: number
    ) => {
      const response: {
        statusCode: number;
        body: any;
      } = {
        statusCode: 200,
        body: undefined,
      };

      const req: any = {
        params: { id: String(conversationId) },
        user: { sellerId },
        app: {
          get: () => undefined,
        },
      };

      const res: any = {
        status(code: number) {
          response.statusCode = code;
          return this;
        },
        json(body: any) {
          response.body = body;
          return this;
        },
      };

      let nextError: unknown;

      await getMessages(req, res, (error: unknown) => {
        nextError = error;
      });

      if (nextError) {
        throw nextError;
      }

      return response;
    };

    const transferToB = async (
      phoneNumberId: string,
      connectionAId: number,
      connectionBId: number,
      conversationId: number,
      sellerBId: number
    ) => {
      await prisma.$transaction(async (tx: any) => {
        await acquirePhoneNumberLock(tx, phoneNumberId);

        await tx.whatsAppPhoneOwnership.updateMany({
          where: {
            connectionId: connectionAId,
            isActive: true,
          },
          data: { isActive: false },
        });

        await tx.whatsAppPhoneOwnership.create({
          data: {
            phoneNumberId,
            connectionId: connectionBId,
            sellerId: sellerBId,
            wabaId: `WABA-${stamp}`,
            isActive: true,
          },
        });

        await tx.conversation.update({
          where: { id: conversationId },
          data: { sellerId: sellerBId },
        });
      });
    };

    before(async () => {
      prisma = (await import("../prisma/client")).default;

      const controller = await import("./conversation.controller");
      getMessages = controller.getMessages;

      const ownership = await import(
        "../services/whatsappOwnership.service"
      );

      acquirePhoneNumberLock = ownership.acquirePhoneNumberLock;
      syncConnectionOwnership = ownership.syncConnectionOwnership;
    });

    after(async () => {
      if (!prisma) return;

      await prisma.message.deleteMany({
        where: {
          conversationId: { in: conversationIds },
        },
      });

      await prisma.conversation.deleteMany({
        where: { id: { in: conversationIds } },
      });

      await prisma.whatsAppPhoneOwnership.deleteMany({
        where: { connectionId: { in: connectionIds } },
      });

      await prisma.channelConnection.deleteMany({
        where: { id: { in: connectionIds } },
      });

      await prisma.seller.deleteMany({
        where: { id: { in: sellerIds } },
      });

      await prisma.$disconnect();
    });

    it("rejects the former owner after transfer without reading messages", async () => {
      const phone = `f2-a-${stamp}`;
      const sellerA = await createSeller("former");
      const sellerB = await createSeller("current");

      const connectionA = await createConnection(sellerA.id, phone);
      const connectionB = await createConnection(sellerB.id, phone);

      await establishOwnership(connectionA, sellerA.id, phone);

      const conversation = await createConversation(sellerA.id, phone);
      const message = await createUnreadMessage(conversation.id);

      await transferToB(
        phone,
        connectionA.id,
        connectionB.id,
        conversation.id,
        sellerB.id
      );

      const response = await invokeGetMessages(
        conversation.id,
        sellerA.id
      );

      assert.equal(response.statusCode, 404);

      const storedMessage = await prisma.message.findUnique({
        where: { id: message.id },
      });

      const storedConversation = await prisma.conversation.findUnique({
        where: { id: conversation.id },
      });

      assert.equal(storedMessage.isRead, false);
      assert.equal(storedConversation.unreadCount, 1);
      assert.equal(storedConversation.sellerId, sellerB.id);
    });

    it("rejects an unrelated seller without changing read state", async () => {
      const phone = `f2-b-${stamp}`;
      const owner = await createSeller("owner");
      const unrelated = await createSeller("unrelated");

      const connection = await createConnection(owner.id, phone);
      await establishOwnership(connection, owner.id, phone);

      const conversation = await createConversation(owner.id, phone);
      const message = await createUnreadMessage(conversation.id);

      const response = await invokeGetMessages(
        conversation.id,
        unrelated.id
      );

      assert.equal(response.statusCode, 404);

      const storedMessage = await prisma.message.findUnique({
        where: { id: message.id },
      });

      const storedConversation = await prisma.conversation.findUnique({
        where: { id: conversation.id },
      });

      assert.equal(storedMessage.isRead, false);
      assert.equal(storedConversation.unreadCount, 1);
    });

    it("allows the current owner and marks customer messages read", async () => {
      const phone = `f2-c-${stamp}`;
      const sellerA = await createSeller("old");
      const sellerB = await createSeller("new");

      const connectionA = await createConnection(sellerA.id, phone);
      const connectionB = await createConnection(sellerB.id, phone);

      await establishOwnership(connectionA, sellerA.id, phone);

      const conversation = await createConversation(sellerA.id, phone);
      const message = await createUnreadMessage(conversation.id);

      await transferToB(
        phone,
        connectionA.id,
        connectionB.id,
        conversation.id,
        sellerB.id
      );

      const response = await invokeGetMessages(
        conversation.id,
        sellerB.id
      );

      assert.equal(response.statusCode, 200);
      assert.equal(response.body.length, 1);
      assert.equal(response.body[0].id, message.id);

      const storedMessage = await prisma.message.findUnique({
        where: { id: message.id },
      });

      const storedConversation = await prisma.conversation.findUnique({
        where: { id: conversation.id },
      });

      assert.equal(storedMessage.isRead, true);
      assert.equal(storedConversation.unreadCount, 0);
    });

    it("waits for a transfer holding the phone lock and rejects the former owner", async () => {
      const phone = `f2-d-${stamp}`;
      const sellerA = await createSeller("race-a");
      const sellerB = await createSeller("race-b");

      const connectionA = await createConnection(sellerA.id, phone);
      const connectionB = await createConnection(sellerB.id, phone);

      await establishOwnership(connectionA, sellerA.id, phone);

      const conversation = await createConversation(sellerA.id, phone);
      const message = await createUnreadMessage(conversation.id);

      let lockHeld = false;
      let transferCommitted = false;

      const transferPromise = prisma.$transaction(async (tx: any) => {
        await acquirePhoneNumberLock(tx, phone);
        lockHeld = true;

        await tx.whatsAppPhoneOwnership.updateMany({
          where: {
            connectionId: connectionA.id,
            isActive: true,
          },
          data: { isActive: false },
        });

        await tx.whatsAppPhoneOwnership.create({
          data: {
            phoneNumberId: phone,
            connectionId: connectionB.id,
            sellerId: sellerB.id,
            wabaId: `WABA-${stamp}`,
            isActive: true,
          },
        });

        await tx.conversation.update({
          where: { id: conversation.id },
          data: { sellerId: sellerB.id },
        });

        await sleep(750);
        transferCommitted = true;
      });

      for (let i = 0; i < 100 && !lockHeld; i += 1) {
        await sleep(20);
      }

      assert.ok(lockHeld, "transfer must acquire phone lock");

      const requestPromise = invokeGetMessages(
        conversation.id,
        sellerA.id
      );

      await sleep(200);

      assert.equal(
        transferCommitted,
        false,
        "transfer should still hold the lock"
      );

      await transferPromise;

      const response = await requestPromise;

      assert.equal(response.statusCode, 404);

      const storedMessage = await prisma.message.findUnique({
        where: { id: message.id },
      });

      const storedConversation = await prisma.conversation.findUnique({
        where: { id: conversation.id },
      });

      assert.equal(storedMessage.isRead, false);
      assert.equal(storedConversation.unreadCount, 1);
      assert.equal(storedConversation.sellerId, sellerB.id);
    });

    it("continues to authorize non-WhatsApp conversations by seller ownership", async () => {
      const seller = await createSeller("instagram");

      const conversation = await createConversation(
        seller.id,
        "",
        "INSTAGRAM"
      );

      const message = await createUnreadMessage(conversation.id);

      const response = await invokeGetMessages(
        conversation.id,
        seller.id
      );

      assert.equal(response.statusCode, 200);
      assert.equal(response.body.length, 1);

      const storedMessage = await prisma.message.findUnique({
        where: { id: message.id },
      });

      assert.equal(storedMessage.isRead, true);
    });
    it("completes a read that acquired the phone lock before a waiting ownership transfer", async () => {
        const phone = `f2-e-${stamp}`;
        const sellerA = await createSeller("read-first-a");
        const sellerB = await createSeller("read-first-b");

        const connectionA = await createConnection(sellerA.id, phone);
        const connectionB = await createConnection(sellerB.id, phone);

        await establishOwnership(connectionA, sellerA.id, phone);

        const conversation = await createConversation(sellerA.id, phone);
        const message = await createUnreadMessage(conversation.id);

        let releaseBlocker!: () => void;
        let tableLockAcquired = false;
        let transferCommitted = false;

        const blockerRelease = new Promise<void>((resolve) => {
            releaseBlocker = resolve;
        });

        // Temporarily block ownership-table queries.
        const blockerPromise = prisma.$transaction(async (tx: any) => {
            await tx.$executeRawUnsafe(
            'LOCK TABLE "WhatsAppPhoneOwnership" IN ACCESS EXCLUSIVE MODE'
            );

            tableLockAcquired = true;
            await blockerRelease;
        });

        try {
            // Wait until PostgreSQL confirms the temporary table lock.
            for (let i = 0; i < 100 && !tableLockAcquired; i += 1) {
            await sleep(20);
            }

            assert.ok(tableLockAcquired, "temporary table lock must be acquired");

            // Start Seller A's read. It should acquire the phone lock,
            // then wait when it tries to read the ownership table.
            const requestPromise = invokeGetMessages(
            conversation.id,
            sellerA.id
            );

            const lockState = async () => {
            const rows = await prisma.$queryRaw`
                SELECT
                EXISTS (
                    SELECT 1
                    FROM pg_locks
                    WHERE locktype = 'advisory'
                    AND granted = true
                    AND classid = (
                        (hashtext(${phone})::bigint >> 32)
                        & 4294967295
                    )::oid
                    AND objid = (
                        hashtext(${phone})::bigint
                        & 4294967295
                    )::oid
                    AND objsubid = 1
                ) AS holder,
                EXISTS (
                    SELECT 1
                    FROM pg_locks
                    WHERE locktype = 'advisory'
                    AND granted = false
                    AND classid = (
                        (hashtext(${phone})::bigint >> 32)
                        & 4294967295
                    )::oid
                    AND objid = (
                        hashtext(${phone})::bigint
                        & 4294967295
                    )::oid
                    AND objsubid = 1
                ) AS waiter
            `;

            return rows[0];
            };

            let state: any;

            for (let i = 0; i < 100; i += 1) {
            state = await lockState();
            if (state.holder) break;
            await sleep(20);
            }

            assert.equal(
            state?.holder,
            true,
            "Seller A's read must acquire the phone lock before ownership lookup"
            );

            // Start Seller B's transfer. It must wait for Seller A's lock.
            const transferPromise = (async () => {
            await transferToB(
                phone,
                connectionA.id,
                connectionB.id,
                conversation.id,
                sellerB.id
            );

            transferCommitted = true;
            })();

            for (let i = 0; i < 100; i += 1) {
            state = await lockState();
            if (state.waiter) break;
            await sleep(20);
            }

            assert.equal(
            state?.waiter,
            true,
            "ownership transfer must wait for Seller A's phone lock"
            );

            assert.equal(
            transferCommitted,
            false,
            "ownership transfer must not commit while Seller A holds the lock"
            );

            // Allow Seller A's ownership lookup and read transaction to finish.
            releaseBlocker();

            const response = await requestPromise;

            assert.equal(response.statusCode, 200);
            assert.equal(response.body.length, 1);
            assert.equal(response.body[0].id, message.id);

            await transferPromise;

            assert.equal(transferCommitted, true);

            const storedMessage = await prisma.message.findUnique({
            where: { id: message.id },
            });

            const storedConversation = await prisma.conversation.findUnique({
            where: { id: conversation.id },
            });

            assert.equal(storedMessage.isRead, true);
            assert.equal(storedConversation.sellerId, sellerB.id);
        } finally {
            // Always release the temporary table lock, even if an assertion fails.
            releaseBlocker();
            await blockerPromise;
        }
        });

  }
);
