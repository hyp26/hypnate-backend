
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import prisma from "../prisma/client";
import { assignConversation } from "./assign.controller";
import {
  acquirePhoneNumberLock,
  syncConnectionOwnership,
} from "../services/whatsappOwnership.service";

const hasDatabase = Boolean(process.env.DATABASE_URL);

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

type MockSocket = {
  data: { sellerId: number };
  emitted: Array<{ event: string; payload: unknown }>;
  emit: (event: string, payload: unknown) => void;
};

type RoomEmission = {
  room: string;
  event: string;
  payload: unknown;
};

const createSocket = (sellerId: number): MockSocket => {
  const emitted: MockSocket["emitted"] = [];

  return {
    data: { sellerId },
    emitted,
    emit: (event, payload) => {
      emitted.push({ event, payload });
    },
  };
};

const createIo = (sockets: MockSocket[]) => {
  const roomEmits: RoomEmission[] = [];

  const io = {
    in: (room: string) => ({
      fetchSockets: async () => sockets,
      emit: (event: string, payload: unknown) => {
        roomEmits.push({ room, event, payload });
      },
    }),
    roomEmits,
  };

  return io;
};

describe(
  "assignConversation database regression tests",
  { skip: !hasDatabase },
  () => {
    const stamp = `assign-test-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;

    const sellerIds: number[] = [];
    const userIds: number[] = [];
    const connectionIds: number[] = [];
    const conversationIds: number[] = [];

    before(async () => {
      await prisma.$connect();
    });

    after(async () => {
      if (conversationIds.length > 0) {
        await prisma.conversation.deleteMany({
          where: { id: { in: conversationIds } },
        });
      }

      if (connectionIds.length > 0) {
        await prisma.whatsAppPhoneOwnership.deleteMany({
          where: { connectionId: { in: connectionIds } },
        });

        await prisma.channelConnection.deleteMany({
          where: { id: { in: connectionIds } },
        });
      }

      if (userIds.length > 0) {
        await prisma.user.deleteMany({
          where: { id: { in: userIds } },
        });
      }

      if (sellerIds.length > 0) {
        await prisma.seller.deleteMany({
          where: { id: { in: sellerIds } },
        });
      }

      await prisma.$disconnect();
    });

    const createSeller = async (label: string) => {
      const seller = await prisma.seller.create({
        data: {
          businessName: `${stamp}-${label}`,
        },
      });

      sellerIds.push(seller.id);
      return seller;
    };

    const createUser = async (sellerId: number, label: string) => {
      const user = await prisma.user.create({
        data: {
          name: `${stamp}-${label}`,
          email: `${stamp}-${label}@example.test`,
          sellerId,
        },
      });

      userIds.push(user.id);
      return user;
    };

    const createConnection = async (
      sellerId: number,
      phoneNumberId: string,
      label: string
    ) => {
      const connection = await prisma.channelConnection.create({
        data: {
          sellerId,
          platform: "WHATSAPP",
          name: `${stamp}-${label}`,
          accessToken: `test-token-${stamp}-${label}`,
          metadata: {
            phoneNumberIds: [phoneNumberId],
          },
          isActive: true,
        },
      });

      connectionIds.push(connection.id);
      return connection;
    };

    const establishOwnership = async (
        sellerId: number,
        connectionId: number,
        _phoneNumberId: string
        ) => {
        const connection = await prisma.channelConnection.findFirst({
            where: {
            id: connectionId,
            sellerId,
            },
            select: {
            id: true,
            sellerId: true,
            metadata: true,
            },
        });

        assert.ok(connection, "WhatsApp connection fixture must exist");

        await prisma.$transaction(async (tx) => {
            await syncConnectionOwnership(
            tx,
            {
                id: connection.id,
                sellerId: connection.sellerId,
                metadata: connection.metadata,
            },
            null
            );
        });
        };

    const createConversation = async (
      sellerId: number,
      phoneNumberId: string,
      assignedToId: number | null = null
    ) => {
      const conversation = await prisma.conversation.create({
        data: {
          sellerId,
          platform: "WHATSAPP",
          customerName: `${stamp}-customer`,
          externalUserId: `${stamp}-external-user-${phoneNumberId}`,
          externalThreadId: phoneNumberId,
          assignedToId,
        },
      });

      conversationIds.push(conversation.id);
      return conversation;
    };

    const invokeAssign = async (args: {
      conversationId: number;
      sellerId: number;
      assignedToId: number | null;
      io: ReturnType<typeof createIo>;
    }) => {
      let statusCode = 200;
      let responseBody: any;

      const req: any = {
        params: {
          id: String(args.conversationId),
        },
        body: {
          assignedToId: args.assignedToId,
        },
        user: {
          sellerId: args.sellerId,
        },
        app: {
          get: () => args.io,
        },
      };

      const res: any = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(body: unknown) {
          responseBody = body;
          return this;
        },
      };

      await assignConversation(req, res);

      return {
        statusCode,
        responseBody,
      };
    };

    const waitForAdvisoryLockWaiter = async (
      phoneNumberId: string,
      timeoutMs = 5000
    ) => {
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        const rows = await prisma.$queryRaw<
          Array<{ waiting: boolean }>
        >`
          SELECT EXISTS (
            SELECT 1
            FROM pg_locks
            WHERE locktype = 'advisory'
              AND granted = false
              AND classid = 0::oid
              AND objid = (
                (hashtext(${phoneNumberId})::bigint & 4294967295)::oid
              )
              AND objsubid = 1
          ) AS waiting
        `;

        if (rows[0]?.waiting) {
          return true;
        }

        await sleep(25);
      }

      return false;
    };

    it("assigns a conversation to a user belonging to the same seller", async () => {
      const seller = await createSeller("same-seller");
      const user = await createUser(seller.id, "assignee");

      const phoneNumberId = `${stamp}-phone-assignment`;
      const connection = await createConnection(
        seller.id,
        phoneNumberId,
        "assignment"
      );

      await establishOwnership(
        seller.id,
        connection.id,
        phoneNumberId
      );

      const conversation = await createConversation(
        seller.id,
        phoneNumberId
      );

      const sellerSocket = createSocket(seller.id);
      const io = createIo([sellerSocket]);

      const result = await invokeAssign({
        conversationId: conversation.id,
        sellerId: seller.id,
        assignedToId: user.id,
        io,
      });

      assert.equal(result.statusCode, 200);
      assert.equal(result.responseBody?.success, true);

      const stored = await prisma.conversation.findUnique({
        where: { id: conversation.id },
      });

      assert.equal(stored?.assignedToId, user.id);

      assert.ok(
        io.roomEmits.some(
          (item) =>
            item.room === `seller_${seller.id}` &&
            item.event === "conversation_updated"
        ),
        "seller room should receive the assignment event"
      );

      assert.ok(
        sellerSocket.emitted.some(
          (item) => item.event === "conversation_updated"
        ),
        "authorized seller socket should receive the event"
      );
    });

    it("supports unassignment and emits the refreshed conversation", async () => {
      const seller = await createSeller("unassignment");
      const user = await createUser(seller.id, "unassignment-user");

      const phoneNumberId = `${stamp}-phone-unassignment`;
      const connection = await createConnection(
        seller.id,
        phoneNumberId,
        "unassignment"
      );

      await establishOwnership(
        seller.id,
        connection.id,
        phoneNumberId
      );

      const conversation = await createConversation(
        seller.id,
        phoneNumberId,
        user.id
      );

      const io = createIo([createSocket(seller.id)]);

      const result = await invokeAssign({
        conversationId: conversation.id,
        sellerId: seller.id,
        assignedToId: null,
        io,
      });

      assert.equal(result.statusCode, 200);
      assert.equal(result.responseBody?.success, true);

      const stored = await prisma.conversation.findUnique({
        where: { id: conversation.id },
      });

      assert.equal(stored?.assignedToId, null);

      const emission = io.roomEmits.find(
        (item) =>
          item.room === `seller_${seller.id}` &&
          item.event === "conversation_updated"
      );

      assert.ok(emission, "seller room should receive the event");

      const payload = emission.payload as {
        conversation?: { assignedToId?: number | null };
      };

      assert.equal(payload.conversation?.assignedToId, null);
    });

    it("rejects assigning a conversation to another seller's user", async () => {
      const sellerA = await createSeller("cross-tenant-a");
      const sellerB = await createSeller("cross-tenant-b");
      const foreignUser = await createUser(
        sellerB.id,
        "foreign-assignee"
      );

      const phoneNumberId = `${stamp}-phone-cross-tenant`;
      const connection = await createConnection(
        sellerA.id,
        phoneNumberId,
        "cross-tenant"
      );

      await establishOwnership(
        sellerA.id,
        connection.id,
        phoneNumberId
      );

      const conversation = await createConversation(
        sellerA.id,
        phoneNumberId
      );

      const io = createIo([
        createSocket(sellerA.id),
        createSocket(sellerB.id),
      ]);

      const result = await invokeAssign({
        conversationId: conversation.id,
        sellerId: sellerA.id,
        assignedToId: foreignUser.id,
        io,
      });

      assert.equal(result.statusCode, 404);

      const stored = await prisma.conversation.findUnique({
        where: { id: conversation.id },
      });

      assert.equal(stored?.assignedToId, null);
      assert.equal(io.roomEmits.length, 0);
    });

    it("emits to the new owner if ownership transfers before event authorization", async () => {
      const sellerA = await createSeller("race-a");
      const sellerB = await createSeller("race-b");
      const userA = await createUser(sellerA.id, "race-user-a");

      const phoneNumberId = `${stamp}-phone-transfer-race`;

      const connectionA = await createConnection(
        sellerA.id,
        phoneNumberId,
        "race-a"
      );

      const connectionB = await createConnection(
        sellerB.id,
        phoneNumberId,
        "race-b"
      );

      await establishOwnership(
        sellerA.id,
        connectionA.id,
        phoneNumberId
      );

      const conversation = await createConversation(
        sellerA.id,
        phoneNumberId,
        userA.id
      );

      const socketA = createSocket(sellerA.id);
      const socketB = createSocket(sellerB.id);
      const io = createIo([socketA, socketB]);

      let lockAcquired = false;
      let releaseTransfer!: () => void;

      const transferGate = new Promise<void>((resolve) => {
        releaseTransfer = resolve;
      });

      const transferPromise = prisma.$transaction(
        async (tx) => {
          await acquirePhoneNumberLock(tx, phoneNumberId);
          lockAcquired = true;

          await transferGate;

          await tx.whatsAppPhoneOwnership.updateMany({
            where: {
              connectionId: connectionA.id,
              isActive: true,
            },
            data: {
              isActive: false,
            },
          });

          await tx.whatsAppPhoneOwnership.create({
            data: {
              phoneNumberId,
              connectionId: connectionB.id,
              sellerId: sellerB.id,
              isActive: true,
            },
          });

          await tx.conversation.update({
            where: { id: conversation.id },
            data: {
              sellerId: sellerB.id,
            },
          });
        },
        { timeout: 15000 }
      );

      try {
        for (let attempt = 0; attempt < 100 && !lockAcquired; attempt++) {
          await sleep(10);
        }

        assert.equal(
          lockAcquired,
          true,
          "transfer transaction must acquire the phone lock"
        );

        const assignmentPromise = invokeAssign({
          conversationId: conversation.id,
          sellerId: sellerA.id,
          assignedToId: null,
          io,
        });

        const waiting = await waitForAdvisoryLockWaiter(phoneNumberId);

        assert.equal(
          waiting,
          true,
          "assignment event authorization must wait for the phone lock"
        );

        releaseTransfer();
        await transferPromise;

        const result = await assignmentPromise;

        assert.equal(result.statusCode, 200);
        assert.equal(result.responseBody?.success, true);

        const stored = await prisma.conversation.findUnique({
          where: { id: conversation.id },
        });

        assert.equal(stored?.sellerId, sellerB.id);
        assert.equal(stored?.assignedToId, null);

        assert.equal(
          io.roomEmits.some(
            (item) => item.room === `seller_${sellerA.id}`
          ),
          false,
          "previous owner must not receive the seller-room event"
        );

        assert.equal(
          io.roomEmits.some(
            (item) =>
              item.room === `seller_${sellerB.id}` &&
              item.event === "conversation_updated"
          ),
          true,
          "current owner must receive the seller-room event"
        );

        assert.equal(
          socketA.emitted.some(
            (item) => item.event === "conversation_updated"
          ),
          false,
          "previous owner's socket must not receive the event"
        );

        assert.equal(
          socketB.emitted.some(
            (item) => item.event === "conversation_updated"
          ),
          true,
          "current owner's socket must receive the event"
        );
      } finally {
        releaseTransfer();
        await transferPromise.catch(() => undefined);
      }
    });
  }
);
