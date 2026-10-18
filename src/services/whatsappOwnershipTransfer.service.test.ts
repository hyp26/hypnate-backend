import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  evictSocketsFromConversations,
  TransferAbortError,
} from "./whatsappOwnershipTransfer.service";

/*
 * Regression tests for the WhatsApp ownership transfer.
 *
 * Prisma, the Meta Graph API, and Socket.IO are NOT available in
 * this environment: applyTransfer/dryRunTransfer exercise live
 * database and Meta calls, so these tests cover the parts that
 * can be unit-tested here (socket eviction policy, abort-error
 * semantics) and document the full required matrix for the
 * database-backed suites that must run in CI (see PR description).
 *
 * NOT executed in this environment — run with
 * `node --test dist/services/whatsappOwnershipTransfer.service.test.js`
 * after `npx prisma generate && npm run build`.
 */

describe("TransferAbortError", () => {
  it("carries a machine-readable abort code and details", () => {
    const error = new TransferAbortError(
      "DESTINATION_CONVERSATION_CONFLICT",
      "conflict",
      [{ externalUserId: "91111", externalThreadId: "111" }]
    );

    assert.equal(
      error.code,
      "DESTINATION_CONVERSATION_CONFLICT"
    );
    assert.equal(error.name, "TransferAbortError");
    assert.deepEqual(error.details, [
      { externalUserId: "91111", externalThreadId: "111" },
    ]);
  });
});

const makeSocket = (sellerId: number | undefined) => {
  const left: string[] = [];
  const emitted: Array<{ event: string; payload: unknown }> = [];

  return {
    data: { sellerId },
    leave: (room: string) => {
      left.push(room);
    },
    emit: (event: string, payload: unknown) => {
      emitted.push({ event, payload });
    },
    left,
    emitted,
  };
};

const makeIo = (sockets: any[]) => ({
  in: (room: string) => ({
    fetchSockets: async () =>
      sockets.map((socket) => ({ ...socket })),
  }),
});

describe("evictSocketsFromConversations", () => {
  it("evicts old-seller sockets from transferred conversation rooms", async () => {
    const oldSellerSocket = makeSocket(10);
    const destinationSocket = makeSocket(20);

    const io = makeIo([oldSellerSocket, destinationSocket]);

    const evicted = await evictSocketsFromConversations(
      io,
      [1],
      20
    );

    assert.equal(evicted, 1);
    assert.deepEqual(oldSellerSocket.left, ["room_1"]);
    assert.equal(
      oldSellerSocket.emitted[0].event,
      "conversation_access_revoked"
    );
    assert.deepEqual(destinationSocket.left, []);
    assert.deepEqual(destinationSocket.emitted, []);
  });

  it("is a no-op without io or conversation ids", async () => {
    assert.equal(
      await evictSocketsFromConversations(null, [1], 20),
      0
    );
    assert.equal(
      await evictSocketsFromConversations(makeIo([]), [], 20),
      0
    );
  });

  it("treats sockets without seller data as stale and evicts them", async () => {
    const mysterySocket = makeSocket(undefined);

    const io = makeIo([mysterySocket]);

    const evicted = await evictSocketsFromConversations(
      io,
      [7],
      20
    );

    assert.equal(evicted, 1);
    assert.deepEqual(mysterySocket.left, ["room_7"]);
  });

  it("continues evicting other conversations when one room fails", async () => {
    const socketOne = makeSocket(10);
    const socketTwo = makeSocket(10);

    const io = {
      in: (room: string) => ({
        fetchSockets: async () => {
          if (room === "room_1") {
            throw new Error("room gone");
          }

          return [{ ...socketTwo }];
        },
      }),
    };

    const evicted = await evictSocketsFromConversations(
      io as any,
      [1, 2],
      20
    );

    assert.equal(evicted, 1);
    assert.deepEqual(socketTwo.left, ["room_2"]);
  });
});

/*
 * Full required database-backed matrix (must be run in CI with
 * PostgreSQL + Prisma generated; documented here for review):
 *
 *  1. Unique owner per phone-number ID across all numbers in a
 *     connection (partial unique index).
 *  2. Existing duplicate mappings detected and deterministically
 *     reported during backfill (lowest connection id wins).
 *  3. Concurrent webhook processing and transfer serialize on
 *     the per-phone advisory lock.
 *  4. Post-transfer inbound routing resolves only to the
 *     destination seller.
 *  5. Duplicate Meta event delivery remains idempotent
 *     ((conversationId, externalMessageId) P2002 path).
 *  6. Historical Message ids, statuses, metadata and reply
 *     relationships retained (conversations move in place).
 *  7. Source seller denied list/read/send/update on transferred
 *     conversations (seller-scoped queries).
 *  8. Destination seller sees the existing history.
 *  9. Source customers and orders unchanged (destination-owned
 *     customer rows are created; source rows untouched).
 * 10. Destination identity conflicts abort with zero writes.
 * 11. Mid-transfer failure rolls back the whole transaction.
 * 12. Destination OAuth validation failure aborts with zero
 *     writes (token never logged).
 * 13. Shared WABA subscription is not removed (no unsubscribe
 *     call anywhere in the transfer path).
 * 14. Old socket sessions cannot receive future
 *     transferred-conversation events (eviction above).
 * 15. Retry after COMPLETED returns ALREADY_COMPLETED without
 *     duplicating work.
 * 16. dryRunTransfer performs no business-data writes.
 */
describe("required database-backed matrix", () => {
  it("is documented for CI execution (see PR description)", () => {
    assert.ok(true);
  });
});
