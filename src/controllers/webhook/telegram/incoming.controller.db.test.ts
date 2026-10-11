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

    // Exactly one worker owns the claim (200); the loser observes busy
    // and receives a retryable 503 — never a premature acknowledgment.
    const codes = [resA.statusCode, resB.statusCode].sort();
    assert.equal(codes[0], 200);
    assert.equal(codes[1], 503);

    assert.equal(await messageCount(sellerId, 501), 1);

    const conversation = await conversationFor(sellerId, 501);
    assert.ok(conversation);
    assert.equal(conversation.unreadCount, 1);

    assert.equal(
      io.events.filter((e) => e.event === "new_message").length,
      1,
      "exactly one new_message event"
    );

    assert.equal((await ledger(sellerId, 900001)).status, "PROCESSED");
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

    const [resA, resB] = await Promise.all([
      ctrl.telegramWebhook(
        makeReq(sellerId, messageUpdate(900040, 101, 505, "first"), io),
        makeRes()
      ),
      ctrl.telegramWebhook(
        makeReq(sellerId, messageUpdate(900041, 102, 505, "second"), io),
        makeRes()
      ),
    ]);

    // Both are distinct updates, so both may process; the response for
    // each must be a success or a retryable busy, never a false ack.
    for (const r of [resA, resB]) {
      assert.ok([200, 503].includes(r.statusCode));
    }

    const conversations = await prisma.conversation.findMany({
      where: { sellerId, platform: "TELEGRAM", externalUserId: "505" },
    });

    assert.equal(conversations.length, 1, "conversation upsert conflict resolved");

    // If one delivery observed busy, its retry would complete it; both
    // updates were distinct so both messages eventually persist.
    const retryNeeded = [resA, resB].some((r) => r.statusCode === 503);

    if (!retryNeeded) {
      assert.equal(conversations[0].unreadCount, 2);
      assert.equal(await messageCount(sellerId, 505), 2);
    }

    // A busy delivery must be able to complete on retry.
    if (retryNeeded) {
      const busyBody =
        resA.statusCode === 503
          ? messageUpdate(900040, 101, 505, "first")
          : messageUpdate(900041, 102, 505, "second");

      const retry = await ctrl.telegramWebhook(
        makeReq(sellerId, busyBody, io),
        makeRes()
      );

      assert.equal(retry.statusCode, 200);
      assert.equal(await messageCount(sellerId, 505), 2);

      const conversation = await conversationFor(sellerId, 505);
      assert.equal(conversation.unreadCount, 2);
    }
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
