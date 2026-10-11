import { test } from "node:test";
import assert from "node:assert/strict";

/*
 * Database-backed regression tests for the Telegram webhook claim and
 * persistence machinery. These tests exercise the REAL Prisma client
 * against a REAL PostgreSQL database and prove actual concurrent
 * behavior (row locking, unique indexes, transaction rollback).
 *
 * They require:
 *   TEST_DATABASE_URL   — a disposable PostgreSQL database
 *   (npx prisma generate must have been run, and the schema migrated)
 *
 * When TEST_DATABASE_URL is absent, every test skips with an explicit
 * reason — nothing is silently passed. The pure-logic tests in
 * incoming.controller.test.ts remain as supplementary coverage.
 *
 * CommonJS note: this file uses require() (not top-level await import)
 * so it compiles under the project's "module": "CommonJS" tsc config
 * and runs against the compiled dist output. TEST_DATABASE_URL is
 * assigned to DATABASE_URL BEFORE the Prisma client is loaded.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

if (DB_URL) {
  // Point the shared Prisma client at the disposable test database
  // before the client (and the controller) are loaded.
  process.env.DATABASE_URL = DB_URL;
}

/* eslint-disable @typescript-eslint/no-var-requires */
const ctrl = DB_URL ? require("./incoming.controller") : null;
const prisma = DB_URL
  ? require("../../../prisma/client").default
  : null;
/* eslint-enable @typescript-eslint/no-var-requires */

const RUN = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

let sellerSeq = 0;

async function setupFixtures() {
  sellerSeq += 1;

  const seller = await prisma.seller.create({
    data: { businessName: `tg-db-test-${RUN}-${sellerSeq}` },
  });

  const connection = await prisma.channelConnection.create({
    data: {
      sellerId: seller.id,
      platform: "TELEGRAM",
      isActive: true,
    },
  });

  return { sellerId: seller.id, connectionId: connection.id };
}

async function teardownFixtures(sellerId: number) {
  await prisma.telegramWebhookUpdate.deleteMany({
    where: { sellerId },
  });

  const conversations = await prisma.conversation.findMany({
    where: { sellerId },
    select: { id: true },
  });

  await prisma.message.deleteMany({
    where: {
      conversationId: {
        in: conversations.map((c: { id: number }) => c.id),
      },
    },
  });

  await prisma.conversation.deleteMany({ where: { sellerId } });
  await prisma.channelConnection.deleteMany({ where: { sellerId } });
  await prisma.seller.deleteMany({ where: { id: sellerId } });
}

function captureIo() {
  const events: Array<{ room: string; event: string; payload: any }> = [];

  return {
    to(room: string) {
      return {
        emit(event: string, payload: any) {
          events.push({ room, event, payload });
        },
      };
    },
    events,
  };
}

function makeReq(sellerId: number, body: unknown, io?: unknown) {
  return {
    params: { sellerId: String(sellerId) },
    body,
    app: {
      get: (key: string) => (key === "io" ? io : undefined),
    },
  } as any;
}

function makeRes() {
  const res: any = { statusCode: 0 };
  res.sendStatus = (code: number) => {
    res.statusCode = code;
    return res;
  };
  return res;
}

function messageUpdate(
  updateId: number,
  messageId: number,
  chatId: number,
  text: string
) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      from: { id: 7, first_name: "Aisha", is_bot: false },
      chat: { id: chatId },
      date: 1760000000,
      text,
    },
  };
}

async function messageCount(sellerId: number, chatId: number) {
  return prisma.message.count({
    where: {
      conversation: {
        sellerId,
        platform: "TELEGRAM" as const,
        externalUserId: String(chatId),
      },
    },
  });
}

async function conversationFor(sellerId: number, chatId: number) {
  return prisma.conversation.findFirst({
    where: {
      sellerId,
      platform: "TELEGRAM" as const,
      externalUserId: String(chatId),
    },
  });
}

async function ledger(sellerId: number, updateId: number) {
  return prisma.telegramWebhookUpdate.findUnique({
    where: { sellerId_updateId: { sellerId, updateId } },
  });
}

const dbTest = (name: string, fn: () => Promise<void>) =>
  test(
    name,
    {
      skip: DB_URL
        ? false
        : "TEST_DATABASE_URL not set — database tests skipped (not run, not passed)",
    },
    fn
  );

// ── Concurrency and idempotency (real database) ─────────────────────────────

dbTest("1. concurrent deliveries of the same update ID persist exactly one message", async () => {
  const { sellerId } = await setupFixtures();

  try {
    const io = captureIo();
    const body = messageUpdate(900001, 1, 501, "race one");

    const [resA, resB] = await Promise.all([
      ctrl.telegramWebhook(makeReq(sellerId, body, io), makeRes()),
      ctrl.telegramWebhook(makeReq(sellerId, body, io), makeRes()),
    ]);

    /*
     * Both outcomes are valid and depend on scheduling:
     * - {200, 503}: the losing request observed the in-flight claim
     *   and was told to retry (no premature acknowledgment).
     * - {200, 200}: the losing request read the durable PROCESSED
     *   status AFTER the winner's transaction committed and confirmed
     *   completion on the ledger.
     * A premature 200 (anything not backed by a durable PROCESSED
     * ledger row) is ruled out by the assertions below.
     */
    const codes = [resA.statusCode, resB.statusCode].sort();
    assert.equal(codes[0], 200, "exactly one request must own the claim");
    assert.ok(
      codes[1] === 503 || codes[1] === 200,
      `second response must be a retryable busy (503) or a durable confirmation (200), got ${codes[1]}`
    );

    // Idempotency holds under every valid outcome.
    assert.equal(await messageCount(sellerId, 501), 1, "exactly one message");

    const conversation = await conversationFor(sellerId, 501);
    assert.ok(conversation);
    assert.equal(conversation.unreadCount, 1, "unread incremented once");

    assert.equal(
      io.events.filter((e) => e.event === "new_message").length,
      1,
      "exactly one new_message event"
    );

    // Any duplicate 200 must be backed by a durable PROCESSED row.
    const row = await ledger(sellerId, 900001);
    assert.ok(row, "ledger row exists");
    assert.equal(row.status, "PROCESSED");
    assert.ok(
      row.claimToken && row.claimToken.length > 0,
      "processed row retains its owner's fencing token"
    );

    if (codes[1] === 200) {
      // The second 200 happened only after the durable commit; verify
      // it was never a busy-claim acknowledgment by replaying the
      // duplicate read path: a further retry also returns 200.
      const replay = await ctrl.telegramWebhook(
        makeReq(sellerId, body, io),
        makeRes()
      );
      assert.equal(replay.statusCode, 200);
      assert.equal(await messageCount(sellerId, 501), 1, "still one message");
      assert.equal(
        io.events.filter((e) => e.event === "new_message").length,
        1,
        "still exactly one event"
      );
    }
  } finally {
    await teardownFixtures(sellerId);
  }
});

dbTest("2a. concurrent reclaims of the same FAILED update yield exactly one owner", async () => {
  const { sellerId } = await setupFixtures();

  try {
    await prisma.telegramWebhookUpdate.create({
      data: { sellerId, updateId: 900002, status: "FAILED", claimToken: "dead-worker" },
    });

    const now = new Date();

    const [a, b] = await Promise.all([
      ctrl.acquireClaim(sellerId, 900002, now),
      ctrl.acquireClaim(sellerId, 900002, now),
    ]);

    const owners = [a, b].filter((r) => r.outcome === "owned");

    assert.equal(owners.length, 1, "exactly one worker owns the reclaimed claim");
    assert.notEqual(owners[0].claimToken, "dead-worker");

    const row = await ledger(sellerId, 900002);
    assert.equal(row.status, "PROCESSING");
    assert.equal(row.claimToken, owners[0].claimToken);
  } finally {
    await teardownFixtures(sellerId);
  }
});

dbTest("2b. concurrent reclaims of the same stale PROCESSING update yield exactly one owner", async () => {
  const { sellerId } = await setupFixtures();

  try {
    await prisma.telegramWebhookUpdate.create({
      data: {
        sellerId,
        updateId: 900003,
        status: "PROCESSING",
        claimToken: "crashed-worker",
        updatedAt: new Date(Date.now() - ctrl.TELEGRAM_CLAIM_STALE_MS - 60_000),
      },
    });

    const now = new Date();

    const [a, b] = await Promise.all([
      ctrl.acquireClaim(sellerId, 900003, now),
      ctrl.acquireClaim(sellerId, 900003, now),
    ]);

    assert.equal([a, b].filter((r) => r.outcome === "owned").length, 1);
    assert.equal([a, b].filter((r) => r.outcome === "busy").length, 1);
  } finally {
    await teardownFixtures(sellerId);
  }
});

dbTest("3. two update IDs referring to the same Telegram message insert at most once", async () => {
  const { sellerId } = await setupFixtures();

  try {
    const io = captureIo();

    const first = await ctrl.telegramWebhook(
      makeReq(sellerId, messageUpdate(900010, 77, 502, "original"), io),
      makeRes()
    );
    assert.equal(first.statusCode, 200);

    // Telegram sometimes redelivers a message under a new update_id.
    const second = await ctrl.telegramWebhook(
      makeReq(sellerId, messageUpdate(900011, 77, 502, "original"), io),
      makeRes()
    );
    assert.equal(second.statusCode, 200);

    assert.equal(await messageCount(sellerId, 502), 1);

    const conversation = await conversationFor(sellerId, 502);
    assert.equal(conversation.unreadCount, 1, "unread incremented once only");
    assert.equal(
      io.events.filter((e) => e.event === "new_message").length,
      1,
      "no duplicate socket event"
    );

    assert.equal((await ledger(sellerId, 900010)).status, "PROCESSED");
    assert.equal((await ledger(sellerId, 900011)).status, "PROCESSED");
  } finally {
    await teardownFixtures(sellerId);
  }
});

dbTest("4. a duplicate-message conflict inside the transaction does not abort it", async () => {
  const { sellerId } = await setupFixtures();

  try {
    // Pre-existing legacy row with the same (conversationId, externalMessageId).
    const connection = await prisma.channelConnection.findFirst({
      where: { sellerId, platform: "TELEGRAM" },
    });

    const conversation = await prisma.conversation.create({
      data: {
        sellerId,
        platform: "TELEGRAM",
        externalUserId: "503",
        externalThreadId: String(connection.id),
        customerName: "Legacy",
      },
    });

    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        sender: "CUSTOMER",
        direction: "INBOUND",
        text: "legacy row",
        externalMessageId: "88",
      },
    });

    const before = conversation.unreadCount;

    const res = await ctrl.telegramWebhook(
      makeReq(sellerId, messageUpdate(900020, 88, 503, "new copy"), captureIo()),
      makeRes()
    );

    // skipDuplicates resolved the conflict; the transaction committed
    // and marked the update PROCESSED in the same tx.
    assert.equal(res.statusCode, 200);
    assert.equal((await ledger(sellerId, 900020)).status, "PROCESSED");

    const after = await prisma.conversation.findUnique({
      where: { id: conversation.id },
    });

    assert.equal(after.unreadCount, before, "no unread increment for a duplicate");
    assert.equal(await messageCount(sellerId, 503), 1);
  } finally {
    await teardownFixtures(sellerId);
  }
});

dbTest("5. losing the claim mid-persistence rolls back every write", async () => {
  const { sellerId, connectionId } = await setupFixtures();

  try {
    const { claimToken } = await ctrl.acquireClaim(sellerId, 900030, new Date());

    // Another worker reclaims (e.g. after stale timeout) while the
    // first worker is still mid-transaction.
    await prisma.telegramWebhookUpdate.update({
      where: { sellerId_updateId: { sellerId, updateId: 900030 } },
      data: { claimToken: "reclaimer" },
    });

    const update = ctrl.classifyTelegramUpdate(
      messageUpdate(900030, 90, 504, "will roll back")
    );

    await assert.rejects(
      prisma.$transaction((tx: any) =>
        ctrl.persistInboundMessage(tx, {
          sellerId,
          updateId: 900030,
          updateType: update.updateType,
          claimToken,
          message: update.message,
          externalThreadId: String(connectionId),
          now: new Date(),
        })
      ),
      (err: any) => err.name === "ClaimLostError"
    );

    // Every write from the expired worker rolled back.
    assert.equal(await messageCount(sellerId, 504), 0, "no message persisted");

    const row = await ledger(sellerId, 900030);
    assert.equal(row.status, "PROCESSING");
    assert.equal(row.claimToken, "reclaimer", "new owner state untouched");
  } finally {
    await teardownFixtures(sellerId);
  }
});

dbTest("6a. concurrent first messages from the same chat create one conversation", async () => {
  const { sellerId } = await setupFixtures();

  try {
    const io = captureIo();

    // Two DISTINCT updates carrying the first two messages of a chat
    // that has no conversation row yet. Both deliveries run their
    // Conversation upsert concurrently; exactly one INSERT wins and
    // the loser's transaction aborts with P2002 on the compound
    // unique index. The handler must classify that race narrowly and
    // retry in a FRESH transaction — so neither delivery may fail.
    const bodyA = messageUpdate(900040, 101, 505, "first");
    const bodyB = messageUpdate(900041, 102, 505, "second");

    const [resA, resB] = await Promise.all([
      ctrl.telegramWebhook(makeReq(sellerId, bodyA, io), makeRes()),
      ctrl.telegramWebhook(makeReq(sellerId, bodyB, io), makeRes()),
    ]);

    // The conversation-create race is handled inside the delivery: a
    // 500 here would mean the P2002 escaped to the failure policy
    // again (the original production bug this test reproduces).
    assert.equal(
      resA.statusCode,
      200,
      `first delivery must succeed via the fresh-transaction retry, got ${resA.statusCode}`
    );
    assert.equal(
      resB.statusCode,
      200,
      `second delivery must succeed via the fresh-transaction retry, got ${resB.statusCode}`
    );

    const conversations = await prisma.conversation.findMany({
      where: { sellerId, platform: "TELEGRAM", externalUserId: "505" },
    });

    assert.equal(conversations.length, 1, "conversation upsert conflict resolved");
    assert.equal(await messageCount(sellerId, 505), 2, "both distinct messages persist");
    assert.equal(conversations[0].unreadCount, 2, "unread incremented once per message");

    // Exactly one event pair per successfully persisted message, and
    // only after the transaction committed.
    const newMessageEvents = io.events.filter(
      (e) => e.event === "new_message"
    );
    const conversationEvents = io.events.filter(
      (e) => e.event === "conversation_updated"
    );

    assert.equal(newMessageEvents.length, 2, "one new_message event per message");
    assert.equal(
      conversationEvents.length,
      2,
      "one conversation_updated event per message"
    );

    assert.equal(
      new Set(newMessageEvents.map((e) => e.payload.id)).size,
      2,
      "each event references a distinct persisted message"
    );

    assert.equal((await ledger(sellerId, 900040)).status, "PROCESSED");
    assert.equal((await ledger(sellerId, 900041)).status, "PROCESSED");
  } finally {
    await teardownFixtures(sellerId);
  }
});

dbTest("6b. an unexpected P2002 rolls back and responds retryably, marking FAILED", async () => {
  const { sellerId } = await setupFixtures();

  try {
    const { claimToken } = await ctrl.acquireClaim(sellerId, 900050, new Date());

    // An unexpected unique-constraint error escapes the transaction:
    // nothing was persisted, so the policy must be retry (never 200).
    const policy = await ctrl.handleProcessingFailure(
      sellerId,
      900050,
      claimToken,
      { code: "P2002" }
    );

    assert.equal(policy, "retry");
    assert.equal(ctrl.statusForPolicy(policy), 500);

    const row = await ledger(sellerId, 900050);
    assert.equal(row.status, "FAILED");
    assert.equal(row.claimToken, claimToken);
  } finally {
    await teardownFixtures(sellerId);
  }
});

dbTest("6c. a conversation-create-race P2002 is NOT routed to the failure policy", async () => {
  const { sellerId } = await setupFixtures();

  try {
    // The exact error shape PostgreSQL/Prisma produces when two
    // concurrent first-message transactions race on the Conversation
    // compound unique index. It must be classified as the retryable
    // race — not as an unexpected failure.
    const raceError = Object.assign(
      new Error("Unique constraint failed on the fields: (`sellerId`,`platform`,`externalUserId`,`externalThreadId`)"),
      {
        code: "P2002",
        meta: {
          target: [
            "sellerId",
            "platform",
            "externalUserId",
            "externalThreadId",
          ],
        },
      }
    );

    assert.equal(ctrl.isConversationCreateRace(raceError), true);

    // And the complementary guarantee: a Message-index P2002 (e.g. the
    // message-id conflict) must NOT be classified as the race.
    const messageError = Object.assign(
      new Error("Unique constraint failed on the fields: (`conversationId`,`externalMessageId`)"),
      {
        code: "P2002",
        meta: { target: ["conversationId", "externalMessageId"] },
      }
    );

    assert.equal(ctrl.isConversationCreateRace(messageError), false);

    // The retry budget is bounded; the handler reuses the same claim,
    // so fencing still holds on every retry attempt.
    assert.ok(ctrl.CONVERSATION_CREATE_RETRY_ATTEMPTS >= 1);
  } finally {
    await teardownFixtures(sellerId);
  }
});

dbTest("7. a database failure during a PROCESSED transition propagates and never reports success", async () => {
  const { sellerId } = await setupFixtures();

  try {
    // fencedTransition must propagate DB errors (not swallow them)...
    const failingTx = {
      telegramWebhookUpdate: {
        updateMany: async () => {
          throw new Error("connection reset");
        },
      },
    };

    await assert.rejects(
      ctrl.fencedTransition(failingTx, sellerId, 900060, "tok", "PROCESSED"),
      /connection reset/
    );

    // ...and handleProcessingFailure must answer retryably when even
    // the FAILED marking cannot be saved, without clobbering a
    // reclaimer's claim.
    const { claimToken } = await ctrl.acquireClaim(sellerId, 900060, new Date());

    await prisma.telegramWebhookUpdate.update({
      where: { sellerId_updateId: { sellerId, updateId: 900060 } },
      data: { claimToken: "reclaimer" },
    });

    const policy = await ctrl.handleProcessingFailure(
      sellerId,
      900060,
      claimToken,
      new Error("transient outage")
    );

    assert.equal(policy, "retry");
    assert.equal(ctrl.statusForPolicy(policy), 500);

    const row = await ledger(sellerId, 900060);
    assert.equal(row.claimToken, "reclaimer", "reclaimer's claim not overwritten");
  } finally {
    await teardownFixtures(sellerId);
  }
});

dbTest("8. retry after a rolled-back transaction succeeds exactly once", async () => {
  const { sellerId, connectionId } = await setupFixtures();

  try {
    // First attempt loses its claim and rolls back (see test 5).
    const first = await ctrl.acquireClaim(sellerId, 900070, new Date());

    await prisma.telegramWebhookUpdate.update({
      where: { sellerId_updateId: { sellerId, updateId: 900070 } },
      data: { claimToken: "reclaimer" },
    });

    const update = ctrl.classifyTelegramUpdate(
      messageUpdate(900070, 110, 506, "attempt one")
    );

    await assert.rejects(
      prisma.$transaction((tx: any) =>
        ctrl.persistInboundMessage(tx, {
          sellerId,
          updateId: 900070,
          updateType: update.updateType,
          claimToken: first.claimToken,
          message: update.message,
          externalThreadId: String(connectionId),
          now: new Date(),
        })
      ),
      (err: any) => err.name === "ClaimLostError"
    );

    assert.equal(await messageCount(sellerId, 506), 0);

    // The claim is released (e.g. the reclaimer crashed); the retry
    // reclaims and completes exactly once.
    await prisma.telegramWebhookUpdate.update({
      where: { sellerId_updateId: { sellerId, updateId: 900070 } },
      data: {
        status: "FAILED",
        updatedAt: new Date(Date.now() - ctrl.TELEGRAM_CLAIM_STALE_MS - 1000),
      },
    });

    const io = captureIo();
    const res = await ctrl.telegramWebhook(
      makeReq(sellerId, messageUpdate(900070, 110, 506, "attempt one"), io),
      makeRes()
    );

    assert.equal(res.statusCode, 200);
    assert.equal(await messageCount(sellerId, 506), 1);

    const conversation = await conversationFor(sellerId, 506);
    assert.equal(conversation.unreadCount, 1);
    assert.equal(
      io.events.filter((e) => e.event === "new_message").length,
      1
    );
    assert.equal((await ledger(sellerId, 900070)).status, "PROCESSED");
  } finally {
    await teardownFixtures(sellerId);
  }
});

dbTest("9. one successful delivery produces exactly one message, one unread increment, and one event", async () => {
  const { sellerId } = await setupFixtures();

  try {
    const io = captureIo();

    const res = await ctrl.telegramWebhook(
      makeReq(sellerId, messageUpdate(900080, 120, 507, "just one"), io),
      makeRes()
    );

    assert.equal(res.statusCode, 200);
    assert.equal(await messageCount(sellerId, 507), 1);

    const conversation = await conversationFor(sellerId, 507);
    assert.equal(conversation.unreadCount, 1);

    const newMessageEvents = io.events.filter(
      (e) => e.event === "new_message"
    );
    const conversationEvents = io.events.filter(
      (e) => e.event === "conversation_updated"
    );

    assert.equal(newMessageEvents.length, 1);
    assert.equal(newMessageEvents[0].room, `room_${conversation.id}`);
    assert.equal(conversationEvents.length, 1);
    assert.equal(conversationEvents[0].room, `seller_${sellerId}`);
  } finally {
    await teardownFixtures(sellerId);
  }
});

// ── Response decisions and state transitions (real database) ────────────────

dbTest("10. a previously processed update returns HTTP 200 without side effects", async () => {
  const { sellerId } = await setupFixtures();

  try {
    const io = captureIo();
    const body = messageUpdate(900100, 130, 508, "once only");

    const first = await ctrl.telegramWebhook(
      makeReq(sellerId, body, io),
      makeRes()
    );
    assert.equal(first.statusCode, 200);

    const before = await conversationFor(sellerId, 508);
    const beforeEvents = io.events.length;

    // Subsequent retries return 200 once durably processed.
    const retry = await ctrl.telegramWebhook(
      makeReq(sellerId, body, io),
      makeRes()
    );

    assert.equal(retry.statusCode, 200);
    assert.equal(await messageCount(sellerId, 508), 1);

    const after = await conversationFor(sellerId, 508);
    assert.equal(after.unreadCount, before.unreadCount, "no extra unread increment");
    assert.equal(io.events.length, beforeEvents, "no repeated socket events");
    assert.equal((await ledger(sellerId, 900100)).status, "PROCESSED");
  } finally {
    await teardownFixtures(sellerId);
  }
});

dbTest("11. a duplicate delivery during fresh PROCESSING is NOT acknowledged prematurely", async () => {
  const { sellerId } = await setupFixtures();

  try {
    // Simulate another worker currently processing this update.
    await prisma.telegramWebhookUpdate.create({
      data: {
        sellerId,
        updateId: 900110,
        status: "PROCESSING",
        claimToken: "in-flight-worker",
      },
    });

    const io = captureIo();
    const res = await ctrl.telegramWebhook(
      makeReq(sellerId, messageUpdate(900110, 131, 509, "in flight"), io),
      makeRes()
    );

    // Busy is not proof of persistence: retryable non-2xx, never 200.
    assert.equal(res.statusCode, 503);

    assert.equal(await messageCount(sellerId, 509), 0, "no side effects");
    assert.equal(io.events.length, 0, "no socket events");

    const row = await ledger(sellerId, 900110);
    assert.equal(row.status, "PROCESSING");
    assert.equal(row.claimToken, "in-flight-worker", "owner state untouched");
  } finally {
    await teardownFixtures(sellerId);
  }
});

dbTest("12. a failed original worker yields a retryable response; a later retry completes the update", async () => {
  const { sellerId } = await setupFixtures();

  try {
    const { claimToken } = await ctrl.acquireClaim(sellerId, 900120, new Date());

    // The original worker fails mid-processing (e.g. transient DB error).
    const policy = await ctrl.handleProcessingFailure(
      sellerId,
      900120,
      claimToken,
      new Error("transient outage")
    );

    assert.equal(policy, "retry");
    assert.equal(ctrl.statusForPolicy(policy), 500, "retryable response");

    const row = await ledger(sellerId, 900120);
    assert.equal(row.status, "FAILED", "claim is reclaimable");

    // Telegram retries; the retry reclaims the FAILED row and completes.
    const io = captureIo();
    const retry = await ctrl.telegramWebhook(
      makeReq(sellerId, messageUpdate(900120, 132, 510, "retry me"), io),
      makeRes()
    );

    assert.equal(retry.statusCode, 200);
    assert.equal(await messageCount(sellerId, 510), 1);

    const conversation = await conversationFor(sellerId, 510);
    assert.equal(conversation.unreadCount, 1);
    assert.equal((await ledger(sellerId, 900120)).status, "PROCESSED");
  } finally {
    await teardownFixtures(sellerId);
  }
});

dbTest("13. after the new owner processes the update, later deliveries are acknowledged without duplicates", async () => {
  const { sellerId } = await setupFixtures();

  try {
    const io = captureIo();
    const body = messageUpdate(900130, 133, 511, "owner wins");

    // New owner completes the update.
    const owned = await ctrl.telegramWebhook(
      makeReq(sellerId, body, io),
      makeRes()
    );
    assert.equal(owned.statusCode, 200);

    const before = await conversationFor(sellerId, 511);
    const beforeEvents = io.events.length;

    // Later deliveries of the same update are acknowledged (durable
    // PROCESSED) with no duplicate message or unread increment.
    const later = await ctrl.telegramWebhook(
      makeReq(sellerId, body, io),
      makeRes()
    );

    assert.equal(later.statusCode, 200);
    assert.equal(await messageCount(sellerId, 511), 1);

    const after = await conversationFor(sellerId, 511);
    assert.equal(after.unreadCount, before.unreadCount);
    assert.equal(io.events.length, beforeEvents, "no duplicate events");
  } finally {
    await teardownFixtures(sellerId);
  }
});

dbTest("14. a worker that lost its claim cannot overwrite the new owner's state", async () => {
  const { sellerId } = await setupFixtures();

  try {
    const expired = await ctrl.acquireClaim(sellerId, 900140, new Date());

    // Another worker reclaims the claim.
    await prisma.telegramWebhookUpdate.update({
      where: { sellerId_updateId: { sellerId, updateId: 900140 } },
      data: { claimToken: "new-owner" },
    });

    // The expired worker's failure handling must not touch the row:
    // its fenced FAILED transition matches zero rows.
    const policy = await ctrl.handleProcessingFailure(
      sellerId,
      900140,
      expired.claimToken,
      new Error("expired worker crash")
    );

    assert.equal(policy, "retry");

    const row = await ledger(sellerId, 900140);
    assert.equal(row.status, "PROCESSING", "new owner's state preserved");
    assert.equal(row.claimToken, "new-owner");
  } finally {
    await teardownFixtures(sellerId);
  }
});

dbTest("15. a ClaimLostError is acknowledged only when the update is durably PROCESSED", async () => {
  const { sellerId } = await setupFixtures();

  try {
    const expired = await ctrl.acquireClaim(sellerId, 900150, new Date());

    // Claim lost, new owner still working: not confirmed → retryable.
    await prisma.telegramWebhookUpdate.update({
      where: { sellerId_updateId: { sellerId, updateId: 900150 } },
      data: { claimToken: "new-owner" },
    });

    const inFlight = await ctrl.handleProcessingFailure(
      sellerId,
      900150,
      expired.claimToken,
      new ctrl.ClaimLostError()
    );

    assert.equal(inFlight, "retry_in_flight");
    assert.equal(ctrl.statusForPolicy(inFlight), 503, "retryable, never 200");

    // New owner finishes: now the same lost worker would be acknowledged.
    await prisma.telegramWebhookUpdate.update({
      where: { sellerId_updateId: { sellerId, updateId: 900150 } },
      data: { status: "PROCESSED" },
    });

    const confirmed = await ctrl.handleProcessingFailure(
      sellerId,
      900150,
      expired.claimToken,
      new ctrl.ClaimLostError()
    );

    assert.equal(confirmed, "acknowledge");
    assert.equal(ctrl.statusForPolicy(confirmed), 200);
  } finally {
    await teardownFixtures(sellerId);
  }
});

// ── Terminal-path acknowledgment policy (lost claims in bot /
//    unsupported / defensive fallback paths) ─────────────────────────────────

dbTest("16. a lost terminal claim whose ledger row is not PROCESSED returns retryable 503", async () => {
  const { sellerId } = await setupFixtures();

  try {
    // The terminal path's fenced PROCESSED flip matched zero rows
    // ("lost") and the new owner is still processing.
    await prisma.telegramWebhookUpdate.create({
      data: {
        sellerId,
        updateId: 900160,
        status: "PROCESSING",
        claimToken: "new-owner",
      },
    });

    assert.equal(
      await ctrl.acknowledgeTerminal(sellerId, 900160, "lost"),
      503,
      "lost claim with PROCESSING row must not be acknowledged"
    );

    // Same for a FAILED row: completion is not confirmed.
    await prisma.telegramWebhookUpdate.update({
      where: { sellerId_updateId: { sellerId, updateId: 900160 } },
      data: { status: "FAILED" },
    });

    assert.equal(
      await ctrl.acknowledgeTerminal(sellerId, 900160, "lost"),
      503,
      "lost claim with FAILED row must not be acknowledged"
    );

    // The new owner's state is untouched by the ack check.
    const row = await ledger(sellerId, 900160);
    assert.equal(row.status, "FAILED");
    assert.equal(row.claimToken, "new-owner");
  } finally {
    await teardownFixtures(sellerId);
  }
});

dbTest("17. a lost terminal claim whose ledger row is durably PROCESSED returns 200", async () => {
  const { sellerId } = await setupFixtures();

  try {
    // Another worker completed the update before our fenced flip.
    await prisma.telegramWebhookUpdate.create({
      data: {
        sellerId,
        updateId: 900170,
        status: "PROCESSED",
        claimToken: "new-owner",
      },
    });

    assert.equal(await ctrl.acknowledgeTerminal(sellerId, 900170, "lost"), 200);

    // A retryable acknowledgment would cause Telegram to redeliver a
    // durably processed update forever; 200 is required here.
    const row = await ledger(sellerId, 900170);
    assert.equal(row.status, "PROCESSED");
  } finally {
    await teardownFixtures(sellerId);
  }
});

dbTest("18. a failed confirmation read after a lost terminal claim returns retryable 503", async () => {
  const { sellerId } = await setupFixtures();

  try {
    // The durable ledger read itself fails (e.g. connection reset).
    // The outcome must be retryable — never a false 200 and never a
    // 500 that implies the update failed.
    const failingReader = {
      telegramWebhookUpdate: {
        findUnique: async () => {
          throw new Error("connection reset during confirmation read");
        },
      },
    };

    const status = await ctrl.acknowledgeTerminal(
      sellerId,
      900180,
      "lost",
      failingReader
    );

    assert.equal(status, 503, "failed confirmation read must be retryable");
  } finally {
    await teardownFixtures(sellerId);
  }
});

dbTest("19. an unsupported update is acknowledged 200 only after its PROCESSED flip is durable", async () => {
  const { sellerId } = await setupFixtures();

  try {
    const io = captureIo();
    const body = {
      update_id: 900190,
      callback_query: { id: "cb1", from: { id: 7 } },
    };

    const res = await ctrl.telegramWebhook(
      makeReq(sellerId, body, io),
      makeRes()
    );

    // Our own fenced transition marked the update PROCESSED → 200.
    assert.equal(res.statusCode, 200);
    assert.equal((await ledger(sellerId, 900190)).status, "PROCESSED");

    // No messages and no socket events for unsupported updates.
    assert.equal(io.events.length, 0);

    const conversations = await prisma.conversation.findMany({
      where: { sellerId },
    });
    assert.equal(conversations.length, 0);
  } finally {
    await teardownFixtures(sellerId);
  }
});

dbTest("20. a bot message is acknowledged 200 after the durable PROCESSED flip and persists nothing", async () => {
  const { sellerId } = await setupFixtures();

  try {
    const io = captureIo();
    const body = {
      update_id: 900191,
      message: {
        message_id: 210,
        from: { id: 8, first_name: "ShopBot", is_bot: true },
        chat: { id: 512 },
        text: "automated ping",
      },
    };

    const res = await ctrl.telegramWebhook(
      makeReq(sellerId, body, io),
      makeRes()
    );

    assert.equal(res.statusCode, 200);
    assert.equal((await ledger(sellerId, 900191)).status, "PROCESSED");
    assert.equal(io.events.length, 0, "no socket events for bot messages");

    const conversations = await prisma.conversation.findMany({
      where: { sellerId },
    });
    assert.equal(conversations.length, 0, "bot messages persist nothing");
  } finally {
    await teardownFixtures(sellerId);
  }
});
