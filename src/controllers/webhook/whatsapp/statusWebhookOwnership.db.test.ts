import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

/*
 * DATABASE-BACKED status-webhook ownership regression tests
 * (audit finding H-2).
 *
 * These tests REQUIRE a disposable PostgreSQL database with the
 * full Prisma migration chain applied:
 *
 *   DATABASE_URL=postgres://... node --test \
 *     dist/controllers/webhook/whatsapp/statusWebhookOwnership.db.test.js
 *
 * They automatically SKIP when DATABASE_URL is not set — a skip
 * is NOT a pass. NEVER point them at a shared, production, or
 * Neon database: they create and delete
 * seller/connection/ownership/conversation/message fixture rows.
 *
 * NOT EXECUTED in the authoring environment (no Node.js and no
 * PostgreSQL available) — see the PR description for the exact
 * verification status.
 */

const hasDatabase = !!process.env.DATABASE_URL;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe(
  "status webhook tenant scoping and locking (H-2)",
  { skip: !hasDatabase },
  () => {
    let prisma: any;
    let processWhatsAppStatuses: any;
    let acquirePhoneNumberLock: any;

    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    const createdSellerIds: number[] = [];
    const createdConnectionIds: number[] = [];
    const createdConversationIds: number[] = [];
    const createdMessageIds: number[] = [];

    const createSeller = async (label: string) => {
      const seller = await prisma.seller.create({
        data: { businessName: `h2-test-${label}-${stamp}` },
      });

      createdSellerIds.push(seller.id);

      return seller;
    };

    /*
     * Active ownership fixture: a WHATSAPP connection plus the
     * authoritative WhatsAppPhoneOwnership row for the phone
     * number. Created directly (not via syncConnectionOwnership)
     * so each test controls the exact ownership state it needs
     * to exercise (active, inactive, missing).
     */
    const createOwnedPhone = async (
      sellerId: number,
      phoneNumberId: string,
      options: { active?: boolean } = {}
    ) => {
      const connection = await prisma.channelConnection.create({
        data: {
          sellerId,
          platform: "WHATSAPP",
          name: `h2-${phoneNumberId}-${stamp}`,
          accessToken: "test-placeholder",
          metadata: { phoneNumberIds: [phoneNumberId] },
          isActive: true,
        },
      });

      createdConnectionIds.push(connection.id);

      await prisma.whatsAppPhoneOwnership.create({
        data: {
          phoneNumberId,
          connectionId: connection.id,
          sellerId,
          wabaId: `WABA-H2-${stamp}`,
          isActive: options.active ?? true,
        },
      });

      return connection;
    };

    const createWhatsAppConversation = async (
      sellerId: number,
      phoneNumberId: string,
      label: string
    ) => {
      const conversation = await prisma.conversation.create({
        data: {
          sellerId,
          platform: "WHATSAPP",
          customerName: `h2-${label}-${stamp}`,
          externalUserId: `ext-${label}-${stamp}`,
          externalThreadId: phoneNumberId,
        },
      });

      createdConversationIds.push(conversation.id);

      return conversation;
    };

    const createOutboundMessage = async (
      conversationId: number,
      externalMessageId: string,
      options: {
        status?: string;
        metadata?: Record<string, unknown>;
      } = {}
    ) => {
      const message = await prisma.message.create({
        data: {
          conversationId,
          sender: "SELLER",
          direction: "OUTBOUND",
          status: options.status ?? "SENT",
          text: "test outbound",
          externalMessageId,
          metadata: options.metadata ?? { preserved: "yes" },
        },
      });

      createdMessageIds.push(message.id);

      return message;
    };

    const statusPayload = (
      phoneNumberId: string | null,
      statuses: Array<Record<string, unknown>>
    ) =>
      ({
        metadata: phoneNumberId
          ? { phone_number_id: phoneNumberId }
          : {},
        statuses,
      }) as Record<string, any>;

    const fetchMessage = async (id: number) =>
      prisma.message.findUnique({ where: { id } });

    before(async () => {
      prisma = (await import("../../../prisma/client")).default;

      const ownershipModule = await import(
        "../../../services/whatsappOwnership.service"
      );

      acquirePhoneNumberLock = ownershipModule.acquirePhoneNumberLock;

      const statusModule = await import("./status.controller");

      processWhatsAppStatuses =
        statusModule.processWhatsAppStatuses;
    });

    after(async () => {
      if (!prisma) {
        return;
      }

      await prisma.message.deleteMany({
        where: { id: { in: createdMessageIds } },
      });

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

    /*
     * A. Missing phone identity — no update, no fallback
     * identity discovery. The handler must return before any
     * database access: even a message whose externalMessageId
     * WOULD match globally must remain untouched, proving no
     * pre-lock/global lookup is used to recover identity.
     */
    it("A: a status without metadata.phone_number_id updates nothing (fail closed, no global lookup)", async () => {
      const phoneNumberId = `71000${Math.floor(Math.random() * 1e5)}`;

      const seller = await createSeller("a");
      await createOwnedPhone(seller.id, phoneNumberId);

      const conversation = await createWhatsAppConversation(
        seller.id,
        phoneNumberId,
        "a"
      );

      const message = await createOutboundMessage(
        conversation.id,
        `h2-ext-a-${stamp}`
      );

      const results = await processWhatsAppStatuses(
        statusPayload(null, [
          {
            id: `h2-ext-a-${stamp}`,
            status: "delivered",
            timestamp: "1717000000",
          },
        ])
      );

      assert.deepEqual(results, []);

      const after = await fetchMessage(message.id);
      assert.equal(after.status, "SENT");
      assert.deepEqual(after.metadata, { preserved: "yes" });
    });

    /*
     * B. Cross-tenant externalMessageId collision. The schema
     * only enforces per-conversation uniqueness of
     * externalMessageId, so two tenants CAN hold the same Meta
     * status id. Only the message scoped to the resolved active
     * owner of the reported phone number may be updated.
     */
    it("B: a colliding externalMessageId in another tenant is never touched", async () => {
      const phoneA = `72100${Math.floor(Math.random() * 1e5)}`;
      const phoneB = `72200${Math.floor(Math.random() * 1e5)}`;
      const sharedExtId = `h2-collide-${stamp}`;

      const sellerA = await createSeller("ba");
      const sellerB = await createSeller("bb");

      await createOwnedPhone(sellerA.id, phoneA);
      await createOwnedPhone(sellerB.id, phoneB);

      const conversationA = await createWhatsAppConversation(
        sellerA.id,
        phoneA,
        "ba"
      );
      const conversationB = await createWhatsAppConversation(
        sellerB.id,
        phoneB,
        "bb"
      );

      const messageA = await createOutboundMessage(
        conversationA.id,
        sharedExtId
      );
      const messageB = await createOutboundMessage(
        conversationB.id,
        sharedExtId
      );

      // Status arrives on tenant B's phone number.
      const results = await processWhatsAppStatuses(
        statusPayload(phoneB, [
          {
            id: sharedExtId,
            status: "delivered",
            timestamp: "1717000001",
          },
        ])
      );

      assert.equal(results.length, 1);
      assert.equal(results[0].message.id, messageB.id);
      assert.equal(results[0].message.status, "DELIVERED");
      assert.equal(results[0].conversation.id, conversationB.id);
      assert.equal(results[0].conversation.sellerId, sellerB.id);

      // Tenant B's message advanced...
      const afterB = await fetchMessage(messageB.id);
      assert.equal(afterB.status, "DELIVERED");
      assert.equal(afterB.metadata.whatsappStatus, "delivered");
      assert.equal(
        afterB.metadata.whatsappStatusTimestamp,
        "1717000001"
      );

      // ...tenant A's message and metadata remain unchanged.
      const afterA = await fetchMessage(messageA.id);
      assert.equal(afterA.status, "SENT");
      assert.deepEqual(afterA.metadata, { preserved: "yes" });
    });

    /*
     * C. Wrong phone-number ID — a status routed to a phone
     * number whose owner has no matching message updates
     * nothing and emits no status event.
     */
    it("C: a phone_number_id that does not match the conversation thread updates nothing", async () => {
      const ownedPhone = `73100${Math.floor(Math.random() * 1e5)}`;
      const foreignPhone = `73200${Math.floor(Math.random() * 1e5)}`;

      const sellerA = await createSeller("ca");
      const sellerB = await createSeller("cb");

      await createOwnedPhone(sellerA.id, ownedPhone);
      // Foreign phone belongs to another tenant entirely.
      await createOwnedPhone(sellerB.id, foreignPhone);

      const conversation = await createWhatsAppConversation(
        sellerA.id,
        ownedPhone,
        "ca"
      );

      const message = await createOutboundMessage(
        conversation.id,
        `h2-ext-c-${stamp}`
      );

      const results = await processWhatsAppStatuses(
        statusPayload(foreignPhone, [
          {
            id: `h2-ext-c-${stamp}`,
            status: "delivered",
            timestamp: "1717000002",
          },
        ])
      );

      assert.deepEqual(results, []);

      const after = await fetchMessage(message.id);
      assert.equal(after.status, "SENT");
      assert.deepEqual(after.metadata, { preserved: "yes" });
    });

    /*
     * D. Unknown or inactive ownership fails closed. The
     * AMBIGUOUS case cannot be constructed at the database
     * level: the partial unique index guarantees at most one
     * active ownership row per phone number, so ambiguity is
     * only reachable in code (resolveActiveOwner checks it as
     * defense in depth) — documented limitation, not tested.
     */
    it("D: unknown active ownership fails closed with no write", async () => {
      const unknownPhone = `74100${Math.floor(Math.random() * 1e5)}`;

      const seller = await createSeller("da");
      // Connection exists but NO ownership row at all.
      await createOwnedPhone(seller.id, `74900${Math.floor(Math.random() * 1e5)}`);

      const conversation = await createWhatsAppConversation(
        seller.id,
        unknownPhone,
        "da"
      );

      const message = await createOutboundMessage(
        conversation.id,
        `h2-ext-d-${stamp}`
      );

      const results = await processWhatsAppStatuses(
        statusPayload(unknownPhone, [
          {
            id: `h2-ext-d-${stamp}`,
            status: "delivered",
            timestamp: "1717000003",
          },
        ])
      );

      assert.deepEqual(results, []);

      const after = await fetchMessage(message.id);
      assert.equal(after.status, "SENT");
      assert.deepEqual(after.metadata, { preserved: "yes" });
    });

    it("D: inactive ownership fails closed with no write", async () => {
      const inactivePhone = `75100${Math.floor(Math.random() * 1e5)}`;

      const seller = await createSeller("db");

      // Ownership row exists but is deactivated (post-transfer
      // / disconnect state for the previous owner).
      await createOwnedPhone(seller.id, inactivePhone, {
        active: false,
      });

      const conversation = await createWhatsAppConversation(
        seller.id,
        inactivePhone,
        "db"
      );

      const message = await createOutboundMessage(
        conversation.id,
        `h2-ext-di-${stamp}`
      );

      const results = await processWhatsAppStatuses(
        statusPayload(inactivePhone, [
          {
            id: `h2-ext-di-${stamp}`,
            status: "delivered",
            timestamp: "1717000004",
          },
        ])
      );

      assert.deepEqual(results, []);

      const after = await fetchMessage(message.id);
      assert.equal(after.status, "SENT");
      assert.deepEqual(after.metadata, { preserved: "yes" });
    });

    /*
     * E. Status webhook versus ownership transfer.
     *
     * A transfer-like transaction holds the SAME per-phone
     * advisory lock the real transfer workflow acquires, then
     * moves ownership and the conversation to seller B while a
     * status webhook for that phone number is in flight. The
     * status handler must block on the lock, then perform its
     * lookup against the POST-transfer state: it may only
     * update the message once the conversation's owner matches
     * the freshly resolved owner, and it must report the NEW
     * owner's sellerId to the H-1 emit-time authorization.
     *
     * LIMITATION (documented, not hidden): this uses an
     * explicitly controlled transfer-like transaction with the
     * same lock and the same ownership/conversation mutations
     * the transfer workflow performs — it is NOT the full
     * transfer implementation (journal rows, disconnects and
     * customer moves are not exercised here).
     */
    it("E: a status webhook in flight during a transfer serializes on the phone lock and never writes against stale ownership", async () => {
      const phoneNumberId = `76100${Math.floor(Math.random() * 1e5)}`;
      const sharedExtId = `h2-race-${stamp}`;

      const sellerA = await createSeller("ea");
      const sellerB = await createSeller("eb");

      const connectionA = await createOwnedPhone(
        sellerA.id,
        phoneNumberId
      );

      // Seller B's connection exists but owns nothing yet.
      const connectionB = await prisma.channelConnection.create({
        data: {
          sellerId: sellerB.id,
          platform: "WHATSAPP",
          name: `h2-dest-${stamp}`,
          accessToken: "test-placeholder",
          metadata: { phoneNumberIds: [phoneNumberId] },
          isActive: true,
        },
      });

      createdConnectionIds.push(connectionB.id);

      const conversation = await createWhatsAppConversation(
        sellerA.id,
        phoneNumberId,
        "ea"
      );

      const message = await createOutboundMessage(
        conversation.id,
        sharedExtId
      );

      let lockHeld = false;
      let transferCommitted = false;

      // Transfer-like transaction: acquires the phone lock
      // first, then performs the ownership + conversation move.
      const transferPromise = prisma.$transaction(async (tx: any) => {
        await acquirePhoneNumberLock(tx, phoneNumberId);

        lockHeld = true;

        await tx.whatsAppPhoneOwnership.updateMany({
          where: { connectionId: connectionA.id, isActive: true },
          data: { isActive: false },
        });

        await tx.whatsAppPhoneOwnership.create({
          data: {
            phoneNumberId,
            connectionId: connectionB.id,
            sellerId: sellerB.id,
            wabaId: `WABA-H2-${stamp}`,
            isActive: true,
          },
        });

        await tx.conversation.update({
          where: { id: conversation.id },
          data: { sellerId: sellerB.id },
        });

        // Window for the status webhook to (incorrectly) run
        // its lookup and write against stale ownership.
        await sleep(750);

        transferCommitted = true;
      });

      for (let i = 0; i < 100 && !lockHeld; i += 1) {
        await sleep(20);
      }

      assert.ok(lockHeld, "transfer must acquire the phone lock");

      const statusPromise = processWhatsAppStatuses(
        statusPayload(phoneNumberId, [
          {
            id: sharedExtId,
            status: "delivered",
            timestamp: "1717000005",
          },
        ])
      );

      // While the transfer is uncommitted, the status handler
      // must be blocked on the lock: no result, no write.
      await sleep(400);

      assert.equal(transferCommitted, false);
      const midMessage = await fetchMessage(message.id);
      assert.equal(midMessage.status, "SENT");
      assert.deepEqual(midMessage.metadata, { preserved: "yes" });

      await transferPromise;

      const results = await statusPromise;

      // The lookup ran under the lock AFTER the transfer
      // committed: owner is B, the conversation now belongs to
      // B, so the scoped lookup matches and the update proceeds
      // with the NEW owner's tenant identity.
      assert.equal(results.length, 1);
      assert.equal(results[0].message.id, message.id);
      assert.equal(results[0].message.status, "DELIVERED");
      assert.equal(results[0].conversation.id, conversation.id);
      assert.equal(results[0].conversation.sellerId, sellerB.id);

      const finalMessage = await fetchMessage(message.id);
      assert.equal(finalMessage.status, "DELIVERED");
      assert.equal(finalMessage.metadata.whatsappStatus, "delivered");
      assert.equal(finalMessage.metadata.preserved, "yes");
    });

    /*
     * Supplemental: replayed / non-advancing statuses continue
     * to be ignored, and FAILED remains terminal — preserved
     * semantics inside the new transactional flow.
     */
    it("preserves delivery ordering: a replayed status makes no change; FAILED always applies", async () => {
      const phoneNumberId = `77100${Math.floor(Math.random() * 1e5)}`;

      const seller = await createSeller("f");
      await createOwnedPhone(seller.id, phoneNumberId);

      const conversation = await createWhatsAppConversation(
        seller.id,
        phoneNumberId,
        "f"
      );

      const message = await createOutboundMessage(
        conversation.id,
        `h2-ext-f-${stamp}`,
        { status: "DELIVERED" }
      );

      // Replay at the same rank: ignored.
      const replay = await processWhatsAppStatuses(
        statusPayload(phoneNumberId, [
          {
            id: `h2-ext-f-${stamp}`,
            status: "delivered",
            timestamp: "1717000006",
          },
        ])
      );

      assert.deepEqual(replay, []);

      const afterReplay = await fetchMessage(message.id);
      assert.equal(afterReplay.status, "DELIVERED");
      assert.deepEqual(afterReplay.metadata, { preserved: "yes" });

      // Downgrade attempt: ignored.
      const downgrade = await processWhatsAppStatuses(
        statusPayload(phoneNumberId, [
          {
            id: `h2-ext-f-${stamp}`,
            status: "sent",
            timestamp: "1717000007",
          },
        ])
      );

      assert.deepEqual(downgrade, []);

      // FAILED is terminal and always applies.
      const failed = await processWhatsAppStatuses(
        statusPayload(phoneNumberId, [
          {
            id: `h2-ext-f-${stamp}`,
            status: "failed",
            timestamp: "1717000008",
            errors: [
              { code: 131047, title: "Re-engagement error" },
            ],
          },
        ])
      );

      assert.equal(failed.length, 1);
      assert.equal(failed[0].message.status, "FAILED");

      const afterFailed = await fetchMessage(message.id);
      assert.equal(afterFailed.status, "FAILED");
      assert.equal(afterFailed.metadata.whatsappErrorCode, "131047");
      assert.equal(
        afterFailed.metadata.whatsappErrorTitle,
        "Re-engagement error"
      );
      assert.equal(afterFailed.metadata.preserved, "yes");
    });
  }
);
