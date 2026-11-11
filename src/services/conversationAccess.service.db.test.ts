
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe(
  "conversation access sharing",
  { skip: !hasDatabase },
  () => {
    let prisma: any;
    let resolveConversationAccess: any;
    let acquirePhoneNumberLock: any;
    let syncConnectionOwnership: any;

    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const sellerIds: number[] = [];
    const connectionIds: number[] = [];
    const conversationIds: number[] = [];
    const shareIds: number[] = [];

    const createSeller = async (label: string) => {
      const seller = await prisma.seller.create({
        data: { businessName: `share-${label}-${stamp}` },
      });
      sellerIds.push(seller.id);
      return seller;
    };

    const createConversation = async (
      sellerId: number,
      platform = "INSTAGRAM",
      phoneNumberId?: string
    ) => {
      const conversation = await prisma.conversation.create({
        data: {
          sellerId,
          platform,
          customerName: `share-customer-${stamp}`,
          externalUserId: `share-user-${stamp}`,
          externalThreadId: phoneNumberId ?? null,
        },
      });
      conversationIds.push(conversation.id);
      return conversation;
    };

    const createWhatsAppConnection = async (
      sellerId: number,
      phoneNumberId: string
    ) => {
      const connection = await prisma.channelConnection.create({
        data: {
          sellerId,
          platform: "WHATSAPP",
          name: `share-${stamp}`,
          accessToken: "test-placeholder",
          metadata: { phoneNumberIds: [phoneNumberId] },
          isActive: true,
        },
      });

      connectionIds.push(connection.id);

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

    const createShare = async (
      conversationId: number,
      ownerSellerId: number,
      sharedWithSellerId: number
    ) => {
      const share = await prisma.conversationShare.create({
        data: {
          conversationId,
          ownerSellerId,
          sharedWithSellerId,
          isActive: true,
        },
      });
      shareIds.push(share.id);
      return share;
    };

      const access = async (conversationId: number, sellerId: number) =>
        prisma.$transaction(
          (tx: any) =>
            resolveConversationAccess(tx, conversationId, sellerId),
          {
            maxWait: 10000,
            timeout: 30000,
          }
        );

    before(async () => {
      prisma = (await import("../prisma/client")).default;

      const service = await import("./conversationAccess.service");
      resolveConversationAccess = service.resolveConversationAccess;

      const ownership = await import("./whatsappOwnership.service");
      acquirePhoneNumberLock = ownership.acquirePhoneNumberLock;
      syncConnectionOwnership = ownership.syncConnectionOwnership;
    });

    after(async () => {
      if (!prisma) return;

      await prisma.conversationShare.deleteMany({
        where: { id: { in: shareIds } },
      });

      await prisma.message.deleteMany({
        where: { conversationId: { in: conversationIds } },
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

    it("allows the original owner without requiring a share", async () => {
      const owner = await createSeller("owner");
      const conversation = await createConversation(owner.id);

      const result = await access(conversation.id, owner.id);

      assert.ok(result);
      assert.equal(result.accessType, "OWNER");
      assert.equal(result.ownerSellerId, owner.id);
    });

    it("allows the explicitly shared recipient", async () => {
      const owner = await createSeller("shared-owner");
      const recipient = await createSeller("recipient");
      const conversation = await createConversation(owner.id);

      await createShare(conversation.id, owner.id, recipient.id);

      const result = await access(conversation.id, recipient.id);

      assert.ok(result);
      assert.equal(result.accessType, "SHARED");
      assert.equal(result.ownerSellerId, owner.id);
      assert.equal(result.conversation.sellerId, owner.id);
    });

    it("denies an unrelated seller", async () => {
      const owner = await createSeller("unrelated-owner");
      const recipient = await createSeller("allowed-recipient");
      const unrelated = await createSeller("unrelated");
      const conversation = await createConversation(owner.id);

      await createShare(conversation.id, owner.id, recipient.id);

      const result = await access(conversation.id, unrelated.id);

      assert.equal(result, null);
    });

    it("denies access after the share is revoked", async () => {
      const owner = await createSeller("revocation-owner");
      const recipient = await createSeller("revocation-recipient");
      const conversation = await createConversation(owner.id);

      const share = await createShare(
        conversation.id,
        owner.id,
        recipient.id
      );

      assert.ok(await access(conversation.id, recipient.id));

      await prisma.conversationShare.update({
        where: { id: share.id },
        data: { isActive: false },
      });

      assert.equal(await access(conversation.id, recipient.id), null);
    });

    it("preserves original ownership when access is shared", async () => {
      const owner = await createSeller("ownership-owner");
      const recipient = await createSeller("ownership-recipient");
      const conversation = await createConversation(owner.id);

      await createShare(conversation.id, owner.id, recipient.id);

      const result = await access(conversation.id, recipient.id);
      const stored = await prisma.conversation.findUnique({
        where: { id: conversation.id },
      });

      assert.ok(result);
      assert.equal(result.accessType, "SHARED");
      assert.equal(stored.sellerId, owner.id);
    });

    it("denies WhatsApp access when normalized ownership disagrees with the conversation", async () => {
      const owner = await createSeller("drift-owner");
      const recipient = await createSeller("drift-recipient");
      const phone = `share-phone-${stamp}`;

      const connection = await createWhatsAppConnection(owner.id, phone);
      const conversation = await createConversation(
        owner.id,
        "WHATSAPP",
        phone
      );

      await createShare(conversation.id, owner.id, recipient.id);

      // Simulate ownership drift without changing the normalized owner.
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { sellerId: recipient.id },
      });

      const result = await access(conversation.id, recipient.id);

      assert.equal(result, null);

      // Restore the row for deterministic fixture cleanup.
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { sellerId: owner.id },
      });

      assert.equal(connection.sellerId, owner.id);
      assert.equal(typeof acquirePhoneNumberLock, "function");
    });
  }
);
