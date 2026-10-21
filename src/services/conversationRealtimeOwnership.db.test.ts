import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

/*
 * DATABASE-BACKED realtime ownership/transfer race tests
 * (audit finding H-1).
 *
 * These tests REQUIRE a disposable PostgreSQL database with the
 * full Prisma migration chain applied:
 *
 *   DATABASE_URL=postgres://... node --test \
 *     dist/services/conversationRealtimeOwnership.db.test.js
 *
 * They automatically SKIP when DATABASE_URL is not set. NEVER
 * point them at a shared or production database: they create and
 * delete seller/connection/ownership/conversation fixture rows.
 *
 * NOT EXECUTED in the authoring environment (no Node.js and no
 * PostgreSQL available) — see the PR description for the exact
 * verification status.
 */

const hasDatabase = !!process.env.DATABASE_URL;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe(
  "realtime emission ownership race (H-1)",
  { skip: !hasDatabase },
  () => {
    let prisma: any;
    let emitAuthorizedConversationEvents: any;
    let acquirePhoneNumberLock: any;
    let syncConnectionOwnership: any;

    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    const createdSellerIds: number[] = [];
    const createdConnectionIds: number[] = [];
    const createdConversationIds: number[] = [];

    const createSeller = async (label: string) => {
      const seller = await prisma.seller.create({
        data: { businessName: `h1-test-${label}-${stamp}` },
      });

      createdSellerIds.push(seller.id);

      return seller;
    };

    const createWhatsAppConnection = async (
      sellerId: number,
      phoneNumberId: string
    ) => {
      const connection = await prisma.channelConnection.create({
        data: {
          sellerId,
          platform: "WHATSAPP",
          name: `test-${stamp}`,
          accessToken: "test-placeholder",
          metadata: { phoneNumberIds: [phoneNumberId] },
          isActive: true,
        },
      });

      createdConnectionIds.push(connection.id);

      // Establish ownership via the guarded sync (H-3 path).
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

      return connection;
    };

    const createWhatsAppConversation = async (
      sellerId: number,
      phoneNumberId: string
    ) => {
      const conversation = await prisma.conversation.create({
        data: {
          sellerId,
          platform: "WHATSAPP",
          customerName: `h1-${stamp}`,
          externalUserId: `ext-${stamp}`,
          externalThreadId: phoneNumberId,
        },
      });

      createdConversationIds.push(conversation.id);

      return conversation;
    };

    /*
     * Create an active WhatsApp connection WITHOUT establishing
     * ownership (seller B's connection in transfer scenarios:
     * the H-3 guarded sync would — correctly — reject seller
     * B's claim while seller A owns the number, so B's
     * ownership row is only ever created by the transfer tx).
     */
    const createConnectionOnly = async (
      sellerId: number,
      phoneNumberId: string
    ) => {
      const connection = await prisma.channelConnection.create({
        data: {
          sellerId,
          platform: "WHATSAPP",
          name: `test-${stamp}`,
          accessToken: "test-placeholder",
          metadata: { phoneNumberIds: [phoneNumberId] },
          isActive: true,
        },
      });

      createdConnectionIds.push(connection.id);

      return connection;
    };

    /*
     * Lock-guarded A→B ownership transfer, mirroring the
     * administrative transfer workflow's core writes: deactivate
     * the source connection's ownership rows, activate the
     * destination's, move the conversation. Must run in a tx.
     */
    const transferToSellerB = async (
      phoneNumberId: string,
      connectionAId: number,
      connectionBId: number,
      sellerBId: number
    ) =>
      prisma.$transaction(async (tx: any) => {
        await acquirePhoneNumberLock(tx, phoneNumberId);

        await tx.whatsAppPhoneOwnership.updateMany({
          where: { connectionId: connectionAId, isActive: true },
          data: { isActive: false },
        });

        const existing =
          await tx.whatsAppPhoneOwnership.findFirst({
            where: {
              phoneNumberId,
              connectionId: connectionBId,
            },
            select: { id: true },
          });

        if (existing) {
          await tx.whatsAppPhoneOwnership.update({
            where: { id: existing.id },
            data: { isActive: true, sellerId: sellerBId },
          });
        } else {
          await tx.whatsAppPhoneOwnership.create({
            data: {
              phoneNumberId,
              connectionId: connectionBId,
              sellerId: sellerBId,
              wabaId: `WABA-${stamp}`,
              isActive: true,
            },
          });
        }
      });

    /*
     * Socket mock: every socket is "joined" to the conversation
     * room (stale membership for seller A after the transfer),
     * and seller-room broadcasts are recorded per room.
     */
    const makeIo = (sellerASocket: any, sellerBSocket: any) => {
      const roomEmits: Array<{ room: string; event: string }> = [];

      const sockets = [sellerASocket, sellerBSocket];

      const io = {
        in: (room: string) => ({
          fetchSockets: async () => sockets,
          emit: (event: string) => {
            roomEmits.push({ room, event });
          },
        }),
        roomEmits,
      };

      return io;
    };

    const makeSocket = (sellerId: number) => {
      const emitted: Array<{ event: string; payload: any }> = [];

      return {
        data: { sellerId },
        emit: (event: string, payload: unknown) => {
          emitted.push({ event, payload: JSON.parse(JSON.stringify(payload)) });
        },
        emitted,
      };
    };

    before(async () => {
      prisma = (await import("../prisma/client")).default;

      const ownershipModule = await import(
        "./whatsappOwnership.service"
      );

      acquirePhoneNumberLock = ownershipModule.acquirePhoneNumberLock;
      syncConnectionOwnership = ownershipModule.syncConnectionOwnership;

      const realtimeModule = await import(
        "./conversationRealtime.service"
      );

      emitAuthorizedConversationEvents =
        realtimeModule.emitAuthorizedConversationEvents;
    });

    after(async () => {
      if (!prisma) {
        return;
      }

      await prisma.conversation.deleteMany({
        where: { id: { in: createdConversationIds } },
      });

      await prisma.whatsAppPhoneOwnership.deleteMany({
        where: { connectionId: { in: createdConnectionIds } },
      });

      await prisma.channelConnection.deleteMany({
        where: { id: { in: createdConnectionIds } },
      });

      await prisma.seller.deleteMany({
        where: { id: { in: createdSellerIds } },
      });
    });

    it("a transfer committed before emission delivers to B only — A's stale room membership receives nothing", async () => {
      const phoneNumberId = `44400${Math.floor(Math.random() * 1e5)}`;

      const sellerA = await createSeller("a");
      const sellerB = await createSeller("b");

      const connectionA = await createWhatsAppConnection(
        sellerA.id,
        phoneNumberId
      );
      const connectionB = await createConnectionOnly(
        sellerB.id,
        phoneNumberId
      );

      // Seller B's sync must not conflict — clear B's ownership
      // created above, then re-create it only inside the
      // transfer below (simulate the transfer activating B).
      await prisma.whatsAppPhoneOwnership.deleteMany({
        where: { connectionId: connectionB.id },
      });

      const conversation = await createWhatsAppConversation(
        sellerA.id,
        phoneNumberId
      );

      // Webhook transaction persisted for A, returned
      // sellerId = A. THEN the transfer commits before emission.
      await transferToSellerB(
        phoneNumberId,
        connectionA.id,
        connectionB.id,
        sellerB.id
      );

      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { sellerId: sellerB.id },
      });

      const socketA = makeSocket(sellerA.id); // stale membership
      const socketB = makeSocket(sellerB.id);
      const io = makeIo(socketA, socketB);

      const authorizedSellerId =
        await emitAuthorizedConversationEvents(io, conversation.id, [
          {
            event: "conversation_updated",
            payload: {
              conversationId: conversation.id,
              conversation: null,
            },
            toSellerRoom: true,
            refreshConversationInPayload: true,
          },
          { event: "new_message", payload: { id: 1, text: "hi" } },
        ]);

      // Authorized against the CURRENT owner (B), not stale A.
      assert.equal(authorizedSellerId, sellerB.id);

      // A receives nothing — neither room nor seller broadcast.
      assert.deepEqual([...socketA.emitted], []);
      assert.deepEqual(
        io.roomEmits.filter((e) => e.room === `seller_${sellerA.id}`),
        []
      );

      // B receives both events.
      assert.equal(socketB.emitted.length, 2);
      assert.deepEqual(
        socketB.emitted.map((e) => e.event),
        ["conversation_updated", "new_message"]
      );

      // Seller-room broadcast went to B's room only.
      assert.deepEqual(
        io.roomEmits.filter((e) => e.room === `seller_${sellerB.id}`),
        [
          { room: `seller_${sellerB.id}`, event: "conversation_updated" },
        ]
      );

      // The refreshed conversation payload reflects the
      // post-transfer row (seller B), never a pre-transfer
      // snapshot.
      const updated = socketB.emitted[0].payload;
      assert.equal(updated.conversation.sellerId, sellerB.id);
    });

    it("emission authorized under the phone lock serializes with a concurrent transfer — no leak in either order", async () => {
      const phoneNumberId = `55500${Math.floor(Math.random() * 1e5)}`;

      const sellerA = await createSeller("c");
      const sellerB = await createSeller("d");

      const connectionA = await createWhatsAppConnection(
        sellerA.id,
        phoneNumberId
      );
      const connectionB = await createConnectionOnly(
        sellerB.id,
        phoneNumberId
      );

      await prisma.whatsAppPhoneOwnership.deleteMany({
        where: { connectionId: connectionB.id },
      });

      const conversation = await createWhatsAppConversation(
        sellerA.id,
        phoneNumberId
      );

      const socketA = makeSocket(sellerA.id);
      const socketB = makeSocket(sellerB.id);
      const io = makeIo(socketA, socketB);

      // The transfer HOLDS the phone lock first (it is
      // mid-flight, owning the lock the emission also needs).
      let lockHeld = false;
      let transferCommitted = false;

      const transferPromise = prisma.$transaction(async (tx: any) => {
        await acquirePhoneNumberLock(tx, phoneNumberId);

        // Transfer now owns the phone lock; start the emission.
        lockHeld = true;

        // Move ownership + conversation to B inside this tx.
        await tx.whatsAppPhoneOwnership.updateMany({
          where: { connectionId: connectionA.id, isActive: true },
          data: { isActive: false },
        });

        await tx.whatsAppPhoneOwnership.create({
          data: {
            phoneNumberId,
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

        // Give the emission time to (incorrectly) proceed and
        // emit to A while the transfer is uncommitted.
        await sleep(750);

        transferCommitted = true;
      });

      // Wait until the transfer visibly holds the lock.
      for (let i = 0; i < 100 && !lockHeld; i += 1) {
        await sleep(20);
      }

      assert.ok(lockHeld, "transfer must acquire the phone lock");

      const emissionPromise = (async () => {
        const result = await emitAuthorizedConversationEvents(
          io,
          conversation.id,
          [
            {
              event: "new_message",
              payload: { id: 2, text: "hello" },
            },
          ]
        );

        return result;
      })();

      // While the transfer is uncommitted, the emission must be
      // blocked on the lock: nothing emitted to anyone yet.
      // Snapshot copies ([...emitted]) keep the compiler from
      // narrowing the LIVE mutable arrays to never[] — they are
      // appended to asynchronously after the transfer commits.
      await sleep(400);

      assert.equal(transferCommitted, false);
      assert.deepEqual([...socketA.emitted], []);
      assert.deepEqual([...socketB.emitted], []);

      await transferPromise;
      const authorizedSellerId = await emissionPromise;

      // The emission re-read under the lock AFTER the transfer
      // committed: it authorizes to B, never to the stale A.
      assert.equal(authorizedSellerId, sellerB.id);
      assert.deepEqual([...socketA.emitted], []);
      assert.equal(socketB.emitted.length, 1);
      assert.equal(socketB.emitted[0].event, "new_message");
    });

    it("fails closed (emits nothing) when the conversation row and ownership mapping disagree (drift)", async () => {
      const phoneNumberId = `66600${Math.floor(Math.random() * 1e5)}`;

      const sellerA = await createSeller("e");
      const sellerB = await createSeller("f");

      const connectionA = await createWhatsAppConnection(
        sellerA.id,
        phoneNumberId
      );
      await createConnectionOnly(sellerB.id, phoneNumberId);
      // Remove B's ownership: A is the active owner, but the
      // conversation still points at B — drift.
      const conversation = await prisma.conversation.create({
        data: {
          sellerId: sellerB.id,
          platform: "WHATSAPP",
          customerName: `h1-drift-${stamp}`,
          externalUserId: `ext-drift-${stamp}`,
          externalThreadId: phoneNumberId,
        },
      });

      createdConversationIds.push(conversation.id);

      const socketA = makeSocket(sellerA.id);
      const socketB = makeSocket(sellerB.id);
      const io = makeIo(socketA, socketB);

      const result = await emitAuthorizedConversationEvents(
        io,
        conversation.id,
        [{ event: "new_message", payload: { id: 3 } }]
      );

      assert.equal(result, null);
      assert.deepEqual([...socketA.emitted], []);
      assert.deepEqual([...socketB.emitted], []);

      void connectionA;
    });

    it("fails closed for a WHATSAPP conversation without a resolvable thread id", async () => {
      const seller = await createSeller("g");

      const conversation = await prisma.conversation.create({
        data: {
          sellerId: seller.id,
          platform: "WHATSAPP",
          customerName: `h1-nothread-${stamp}`,
          externalUserId: `ext-nothread-${stamp}`,
          externalThreadId: null,
        },
      });

      createdConversationIds.push(conversation.id);

      const socket = makeSocket(seller.id);
      const io = makeIo(socket, makeSocket(seller.id + 999));

      const result = await emitAuthorizedConversationEvents(io, conversation.id, [
        { event: "new_message", payload: { id: 4 } },
      ]);

      assert.equal(result, null);
      assert.deepEqual([...socket.emitted], []);
    });

    it("fails closed for a missing conversation id", async () => {
      const io = makeIo(makeSocket(1), makeSocket(2));

      const result = await emitAuthorizedConversationEvents(io, 987654321, [
        { event: "new_message", payload: { id: 5 } },
      ]);

      assert.equal(result, null);
    });

    it("authorizes non-WhatsApp conversations from the conversation row (no transfer mechanism)", async () => {
      const seller = await createSeller("h");

      const conversation = await prisma.conversation.create({
        data: {
          sellerId: seller.id,
          platform: "INSTAGRAM",
          customerName: `h1-ig-${stamp}`,
          externalUserId: `ext-ig-${stamp}`,
        },
      });

      createdConversationIds.push(conversation.id);

      const ownerSocket = makeSocket(seller.id);
      const otherSocket = makeSocket(seller.id + 998);
      const io = makeIo(ownerSocket, otherSocket);

      const result = await emitAuthorizedConversationEvents(io, conversation.id, [
        { event: "conversation_updated", payload: { conversationId: conversation.id } },
      ]);

      assert.equal(result, seller.id);
      assert.equal(ownerSocket.emitted.length, 1);
      assert.deepEqual([...otherSocket.emitted], []);
    });
  }
);
