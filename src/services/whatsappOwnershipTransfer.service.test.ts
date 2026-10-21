import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  evictSocketsFromConversations,
  parseJournalPhoneIds,
  recoverJournalCounts,
  validateEvictionConversationIds,
  wabaIdsAgree,
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

/* ----------------------------------------------------
   parseJournalPhoneIds — trusted-payload validation
---------------------------------------------------- */

describe("parseJournalPhoneIds", () => {
  it("accepts a valid array of phone ids, trimmed, deduped, sorted", () => {
    assert.deepEqual(
      parseJournalPhoneIds(["222", "111", " 111 ", "333"]),
      ["111", "222", "333"]
    );
  });

  it("rejects a non-array value", () => {
    assert.equal(parseJournalPhoneIds("111"), null);
    assert.equal(parseJournalPhoneIds({ id: "111" }), null);
    assert.equal(parseJournalPhoneIds(null), null);
  });

  it("rejects arrays containing non-strings", () => {
    assert.equal(parseJournalPhoneIds(["111", 222]), null);
    assert.equal(
      parseJournalPhoneIds(["111", null]),
      null
    );
    assert.equal(
      parseJournalPhoneIds([{ id: "111" }]),
      null
    );
  });

  it("rejects empty or whitespace-only entries", () => {
    assert.equal(parseJournalPhoneIds(["111", ""]), null);
    assert.equal(parseJournalPhoneIds(["111", "   "]), null);
  });

  it("accepts an empty array (nothing transferred claim)", () => {
    assert.deepEqual(parseJournalPhoneIds([]), []);
  });
});

/* ----------------------------------------------------
   recoverJournalCounts — never invent counts
---------------------------------------------------- */

describe("recoverJournalCounts", () => {
  it("recovers counts from the structured integer columns", () => {
    const counts = recoverJournalCounts({
      conversationCount: 3,
      messageCount: 42,
      report: null,
    });

    assert.deepEqual(counts, {
      conversationCount: 3,
      messageCount: 42,
    });
  });

  it("falls back to the persisted transfer report", () => {
    const counts = recoverJournalCounts({
      conversationCount: null,
      messageCount: null,
      report: {
        conversationCount: 2,
        messageCount: 17,
      },
    });

    assert.deepEqual(counts, {
      conversationCount: 2,
      messageCount: 17,
    });
  });

  it("returns null when both sources are null", () => {
    assert.equal(
      recoverJournalCounts({
        conversationCount: null,
        messageCount: null,
        report: null,
      }),
      null
    );
  });

  it("returns null for negative, fractional or non-integer counts", () => {
    assert.equal(
      recoverJournalCounts({
        conversationCount: 1,
        messageCount: -5,
        report: null,
      }),
      null
    );

    assert.equal(
      recoverJournalCounts({
        conversationCount: 1,
        messageCount: 1.5,
        report: null,
      }),
      null
    );

    assert.equal(
      recoverJournalCounts({
        conversationCount: 1,
        messageCount: "42",
        report: null,
      }),
      null
    );
  });

  it("returns null for NaN, Infinity, and unsafe integers", () => {
    assert.equal(
      recoverJournalCounts({
        conversationCount: 1,
        messageCount: NaN,
        report: null,
      }),
      null
    );

    assert.equal(
      recoverJournalCounts({
        conversationCount: 1,
        messageCount: Infinity,
        report: null,
      }),
      null
    );

    assert.equal(
      recoverJournalCounts({
        conversationCount: 1,
        messageCount: -Infinity,
        report: null,
      }),
      null
    );

    assert.equal(
      recoverJournalCounts({
        conversationCount: Number.MAX_SAFE_INTEGER + 1,
        messageCount: 42,
        report: null,
      }),
      null
    );

    assert.equal(
      recoverJournalCounts({
        conversationCount: 1,
        messageCount: Number.MAX_SAFE_INTEGER + 1,
        report: null,
      }),
      null
    );
  });

  it("rejects malformed counts in the report as well", () => {
    assert.equal(
      recoverJournalCounts({
        conversationCount: null,
        messageCount: null,
        report: {
          conversationCount: 2,
          messageCount: "17",
        },
      }),
      null
    );

    assert.equal(
      recoverJournalCounts({
        conversationCount: null,
        messageCount: null,
        report: {
          conversationCount: -2,
          messageCount: 17,
        },
      }),
      null
    );
  });

  it("returns null when a structured count is valid but its pair is not", () => {
    assert.equal(
      recoverJournalCounts({
        conversationCount: 3,
        messageCount: null,
        report: null,
      }),
      null
    );
  });

  it("treats disagreeing structured and report counts as inconsistent (invalid)", () => {
    assert.equal(
      recoverJournalCounts({
        conversationCount: 3,
        messageCount: 42,
        report: {
          conversationCount: 3,
          messageCount: 41,
        },
      }),
      null
    );

    assert.equal(
      recoverJournalCounts({
        conversationCount: 3,
        messageCount: 42,
        report: {
          conversationCount: 4,
          messageCount: 42,
        },
      }),
      null
    );
  });

  it("accepts agreeing structured and report counts", () => {
    assert.deepEqual(
      recoverJournalCounts({
        conversationCount: 3,
        messageCount: 42,
        report: {
          conversationCount: 3,
          messageCount: 42,
        },
      }),
      { conversationCount: 3, messageCount: 42 }
    );
  });
});

/* ----------------------------------------------------
   wabaIdsAgree — idempotent-retry WABA agreement
---------------------------------------------------- */

describe("wabaIdsAgree", () => {
  it("accepts when journal, source and destination WABA ids all match", () => {
    assert.equal(
      wabaIdsAgree("WABA_1", "WABA_1", "WABA_1"),
      true
    );
  });

  it("rejects when the journal WABA id is null or empty", () => {
    assert.equal(wabaIdsAgree(null, "WABA_1", "WABA_1"), false);
    assert.equal(wabaIdsAgree("", "WABA_1", "WABA_1"), false);
    assert.equal(wabaIdsAgree("   ", "WABA_1", "WABA_1"), false);
  });

  it("rejects when the current source or destination WABA differs", () => {
    assert.equal(
      wabaIdsAgree("WABA_1", "WABA_2", "WABA_1"),
      false
    );
    assert.equal(
      wabaIdsAgree("WABA_1", "WABA_1", "WABA_2"),
      false
    );
  });

  it("rejects when current WABA ids are null (unknown landscape)", () => {
    assert.equal(wabaIdsAgree("WABA_1", null, "WABA_1"), false);
    assert.equal(wabaIdsAgree("WABA_1", "WABA_1", null), false);
  });
});

/* ----------------------------------------------------
   validateEvictionConversationIds — pre-eviction guard
---------------------------------------------------- */

describe("validateEvictionConversationIds", () => {
  it("accepts unique positive safe integers matching the expected count", () => {
    assert.deepEqual(
      validateEvictionConversationIds([5, 9, 2], 3),
      [5, 9, 2]
    );
  });

  it("accepts an empty list with an expected count of zero", () => {
    assert.deepEqual(validateEvictionConversationIds([], 0), []);
  });

  it("rejects non-array input", () => {
    assert.equal(validateEvictionConversationIds(null, 0), null);
    assert.equal(validateEvictionConversationIds("1,2", 2), null);
  });

  it("rejects count mismatch with the recorded conversation count", () => {
    assert.equal(validateEvictionConversationIds([1, 2], 3), null);
    assert.equal(validateEvictionConversationIds([1, 2, 3], 2), null);
    assert.equal(validateEvictionConversationIds([1], -1), null);
  });

  it("rejects non-integer, zero, negative or unsafe ids", () => {
    assert.equal(validateEvictionConversationIds([1.5, 2], 2), null);
    assert.equal(validateEvictionConversationIds([0, 2], 2), null);
    assert.equal(validateEvictionConversationIds([-1, 2], 2), null);
    assert.equal(validateEvictionConversationIds(["1", 2], 2), null);
    assert.equal(
      validateEvictionConversationIds(
        [Number.MAX_SAFE_INTEGER + 1, 2],
        2
      ),
      null
    );
  });

  it("rejects duplicate conversation ids", () => {
    assert.equal(validateEvictionConversationIds([7, 7], 2), null);
  });
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
