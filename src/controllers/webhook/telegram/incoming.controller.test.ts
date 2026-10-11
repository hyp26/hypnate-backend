import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  classifyTelegramUpdate,
  decideClaimAction,
  resolveInboundText,
  isReclaimEligible,
  ownsClaim,
  simulateReclaimRace,
  countEffectsAfterProcessed,
  statusForPolicy,
  acknowledgeTerminal,
  isConversationCreateRace,
  CONVERSATION_CREATE_RETRY_ATTEMPTS,
  TELEGRAM_CLAIM_STALE_MS,
} from "./incoming.controller";

/*
 * CommonJS-compatible source lookup: works both when the suite runs
 * from src (ts-node) and from the compiled dist output. When neither
 * file is reachable the source-scan tests are explicitly SKIPPED via
 * node:test's t.skip() — they are never reported as passed.
 */
function findControllerSource(): string | null {
  const candidates = [
    join(__dirname, "incoming.controller.ts"),
    join(
      __dirname,
      "..",
      "..",
      "..",
      "..",
      "src",
      "controllers",
      "webhook",
      "telegram",
      "incoming.controller.ts"
    ),
  ];

  const found = candidates.find((p) => existsSync(p));

  return found ? readFileSync(found, "utf8") : null;
}

const validUpdate = {
  update_id: 1001,
  message: {
    message_id: 42,
    from: { id: 7, first_name: "Aisha", is_bot: false },
    chat: { id: 555001 },
    date: 1760000000,
    text: "Hello, is this available?",
  },
};

function shiftedUpdate(updateId: number) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 10,
      from: { id: 7, first_name: "Aisha", is_bot: false },
      chat: { id: 555001 },
      date: 1760000001,
      text: `Message ${updateId}`,
    },
  };
}

// ── Classification ──────────────────────────────────────────────────────────

test("a valid inbound message classifies as message", () => {
  const result = classifyTelegramUpdate(validUpdate);

  assert.equal(result.kind, "message");
  assert.equal(result.updateId, 1001);
  assert.ok(result.message);
  assert.equal(result.message.chatId, "555001");
  assert.equal(result.message.messageId, "42");
  assert.equal(result.message.text, "Hello, is this available?");
  assert.equal(result.message.senderName, "Aisha");
  assert.equal(result.message.isBot, false);
  assert.equal(result.message.messageType, "text");
});

test("an edited message classifies as edited_message, not a new message flow", () => {
  const result = classifyTelegramUpdate({
    update_id: 1002,
    edited_message: {
      message_id: 42,
      from: { id: 7, first_name: "Aisha", is_bot: false },
      chat: { id: 555001 },
      text: "Hello, edited",
    },
  });

  assert.equal(result.kind, "edited_message");
  assert.equal(result.updateId, 1002);
  assert.ok(result.message);
});

test("callback queries, channel posts, and member updates are unsupported", () => {
  const callback = classifyTelegramUpdate({
    update_id: 1003,
    callback_query: { id: "cb1", from: { id: 7 } },
  });
  const channelPost = classifyTelegramUpdate({
    update_id: 1004,
    channel_post: { message_id: 1, chat: { id: -100 } },
  });
  const member = classifyTelegramUpdate({
    update_id: 1005,
    my_chat_member: { from: { id: 7 } },
  });

  assert.equal(callback.kind, "unsupported");
  assert.equal(callback.updateType, "callback_query");
  assert.equal(channelPost.kind, "unsupported");
  assert.equal(channelPost.updateType, "channel_post");
  assert.equal(member.kind, "unsupported");
  assert.equal(member.updateType, "my_chat_member");
});

test("updates without a valid positive integer update_id are malformed", () => {
  assert.equal(classifyTelegramUpdate({}).kind, "malformed");
  assert.equal(classifyTelegramUpdate(null).kind, "malformed");
  assert.equal(classifyTelegramUpdate("nope").kind, "malformed");
  assert.equal(
    classifyTelegramUpdate({ update_id: "1001", message: validUpdate.message })
      .kind,
    "malformed"
  );
  assert.equal(
    classifyTelegramUpdate({ update_id: 0, message: validUpdate.message }).kind,
    "malformed"
  );
  assert.equal(
    classifyTelegramUpdate({ update_id: -5, message: validUpdate.message })
      .kind,
    "malformed"
  );
});

test("a message payload missing chat or message_id is malformed", () => {
  const noChat = classifyTelegramUpdate({
    update_id: 1006,
    message: { message_id: 1, from: { id: 7 } },
  });
  const noMessageId = classifyTelegramUpdate({
    update_id: 1007,
    message: { chat: { id: 555001 } },
  });

  assert.equal(noChat.kind, "malformed");
  // The classifier retains a valid update_id even when the nested
  // message payload is malformed; only an invalid/missing update_id
  // produces updateId === null.
  assert.equal(noChat.updateId, 1006);
  assert.equal(noMessageId.kind, "malformed");
  assert.equal(noMessageId.updateId, 1007);
});

test("non-text messages classify as messages with a placeholder text", () => {
  const result = classifyTelegramUpdate({
    update_id: 1008,
    message: {
      message_id: 50,
      from: { id: 7, first_name: "Aisha", is_bot: false },
      chat: { id: 555001 },
      photo: [{ file_id: "abc" }],
    },
  });

  assert.equal(result.kind, "message");
  assert.ok(result.message);
  assert.equal(result.message.messageType, "non_text");
  assert.equal(result.message.text, "[Telegram photo message]");
});

test("bot senders are detected so they can be ignored", () => {
  const result = classifyTelegramUpdate({
    update_id: 1009,
    message: {
      message_id: 51,
      from: { id: 8, first_name: "ShopBot", is_bot: true },
      chat: { id: 555001 },
      text: "Automated ping",
    },
  });

  assert.equal(result.kind, "message");
  assert.equal(result.message?.isBot, true);
});

test("different update ids classify independently", () => {
  const a = classifyTelegramUpdate(shiftedUpdate(2001));
  const b = classifyTelegramUpdate(shiftedUpdate(2002));

  assert.equal(a.updateId, 2001);
  assert.equal(b.updateId, 2002);
  assert.notEqual(a.message?.text, b.message?.text);
});

// ── Text resolution ────────────────────────────────────────────────────────

test("text content is preserved and media maps to placeholders", () => {
  assert.equal(
    resolveInboundText({ text: "hi" }),
    "hi"
  );
  assert.equal(resolveInboundText({ voice: {} }), "[Telegram voice message]");
  assert.equal(resolveInboundText({ document: {} }), "[Telegram document message]");
  assert.equal(resolveInboundText({}), "");
});

// ── Claim decision (read path) ──────────────────────────────────────────────

test("a claimed-elsewhere update with no existing row is processed new", () => {
  assert.equal(decideClaimAction(null), "process_new");
});

test("a PROCESSED row is a duplicate and must not reprocess", () => {
  const action = decideClaimAction({
    status: "PROCESSED",
    updatedAt: new Date(),
  });

  assert.equal(action, "duplicate");
});

test("a FAILED row is reclaimed so a retry can recover", () => {
  const action = decideClaimAction({
    status: "FAILED",
    updatedAt: new Date(),
  });

  assert.equal(action, "reclaim");
});

test("a fresh PROCESSING row is left to its in-flight request", () => {
  const action = decideClaimAction({
    status: "PROCESSING",
    updatedAt: new Date(),
  });

  assert.equal(action, "in_flight");
});

test("a stale PROCESSING row is reclaimed", () => {
  const now = new Date("2026-10-11T12:00:00Z");
  const stale = new Date(
    now.getTime() - TELEGRAM_CLAIM_STALE_MS - 1000
  );

  const action = decideClaimAction(
    { status: "PROCESSING", updatedAt: stale },
    now
  );

  assert.equal(action, "reclaim");
});

test("an almost-stale PROCESSING row is still in flight", () => {
  const now = new Date("2026-10-11T12:00:00Z");
  const recent = new Date(
    now.getTime() - TELEGRAM_CLAIM_STALE_MS + 1000
  );

  const action = decideClaimAction(
    { status: "PROCESSING", updatedAt: recent },
    now
  );

  assert.equal(action, "in_flight");
});

test("unknown statuses without staleness are treated as in flight", () => {
  const action = decideClaimAction({
    status: "WEIRD",
    updatedAt: new Date(),
  });

  assert.equal(action, "in_flight");
});

// ── Reclaim eligibility (write-path WHERE clause) ───────────────────────────

test("only FAILED or stale PROCESSING rows are reclaim eligible", () => {
  const now = new Date("2026-10-11T12:00:00Z");

  assert.equal(
    isReclaimEligible("FAILED", now, now),
    true,
    "FAILED rows are always reclaimable"
  );
  assert.equal(
    isReclaimEligible(
      "PROCESSING",
      new Date(now.getTime() - TELEGRAM_CLAIM_STALE_MS - 1),
      now
    ),
    true,
    "stale PROCESSING rows are reclaimable"
  );
  assert.equal(
    isReclaimEligible("PROCESSING", now, now),
    false,
    "fresh PROCESSING rows are not reclaimable"
  );
  assert.equal(
    isReclaimEligible("PROCESSED", now, now),
    false,
    "PROCESSED rows are never reclaimable"
  );
});

// ── Competing claims during reclamation (atomic race model) ──────────────────

test("exactly one worker wins the reclaim race; all others back off", () => {
  const now = new Date("2026-10-11T12:00:00Z");
  const failed = {
    status: "FAILED",
    updatedAt: new Date(now.getTime() - 60_000),
    claimToken: "old-attempt",
  };

  const outcomes = simulateReclaimRace(failed, 5, now);

  assert.equal(outcomes[0], "owned");
  assert.equal(outcomes.filter((o) => o === "owned").length, 1);
  assert.equal(outcomes.filter((o) => o === "busy").length, 4);
});

test("a fresh PROCESSING row cannot be stolen by any racer", () => {
  const now = new Date("2026-10-11T12:00:00Z");
  const fresh = {
    status: "PROCESSING",
    updatedAt: now,
    claimToken: "in-flight-worker",
  };

  const outcomes = simulateReclaimRace(fresh, 4, now);

  assert.equal(outcomes.filter((o) => o === "owned").length, 0);
  assert.equal(outcomes.filter((o) => o === "busy").length, 4);
});

// ── Duplicate deliveries after success ──────────────────────────────────────

test("duplicate deliveries after success never persist anything", () => {
  const effects = countEffectsAfterProcessed(7);

  assert.equal(effects.deliveries, 7);
  assert.equal(effects.messagesPersisted, 0);
  assert.equal(effects.unreadIncrements, 0);
});

test("a PROCESSED claim is reported as a duplicate by the read path", () => {
  const now = new Date("2026-10-11T12:00:00Z");

  assert.equal(
    decideClaimAction(
      { status: "PROCESSED", updatedAt: now, claimToken: "done" },
      now
    ),
    "duplicate"
  );
});

// ── Claim ownership / fencing ───────────────────────────────────────────────

test("a worker owns its claim only while PROCESSING under its token", () => {
  const now = new Date();
  const token = "worker-a";

  assert.equal(
    ownsClaim({ status: "PROCESSING", updatedAt: now, claimToken: token }, token),
    true
  );
});

test("a worker that lost its claim to a reclaimer no longer owns it", () => {
  const now = new Date();
  const row = {
    status: "PROCESSING",
    updatedAt: now,
    claimToken: "reclaimer-b",
  };

  assert.equal(ownsClaim(row, "expired-worker-a"), false);
});

test("a PROCESSED row is owned by nobody, so no late writes are possible", () => {
  const now = new Date();

  assert.equal(
    ownsClaim({ status: "PROCESSED", updatedAt: now, claimToken: "x" }, "x"),
    false
  );
});

test("a FAILED row is owned by nobody, so a crashed worker cannot self-heal it", () => {
  const now = new Date();

  assert.equal(
    ownsClaim({ status: "FAILED", updatedAt: now, claimToken: "x" }, "x"),
    false
  );
});

test("a null record or null token owns nothing", () => {
  assert.equal(ownsClaim(null, "x"), false);
  assert.equal(
    ownsClaim({ status: "PROCESSING", updatedAt: new Date() }, "x"),
    false
  );
});

// ── Response decisions (pure mapping) ──────────────────────────────────────

test("an acknowledged policy maps to HTTP 200 only", () => {
  assert.equal(statusForPolicy("acknowledge"), 200);
});

test("a processing failure maps to a retryable HTTP 500", () => {
  assert.equal(statusForPolicy("retry"), 500);
});

test("an unconfirmed in-flight claim maps to a retryable HTTP 503, never 200", () => {
  assert.equal(statusForPolicy("retry_in_flight"), 503);
});

// ── Terminal acknowledgment policy (supplementary; DB suite has the
// real-database versions of the "lost" cases) ─────────────────────────────────

function readerReturning(row: unknown) {
  return {
    telegramWebhookUpdate: {
      findUnique: async () => row,
    },
  };
}

function failingReader() {
  return {
    telegramWebhookUpdate: {
      findUnique: async () => {
        throw new Error("connection reset during confirmation read");
      },
    },
  };
}

test("a marked terminal transition is acknowledged with 200", async () => {
  assert.equal(await acknowledgeTerminal(1, 100, "marked"), 200);
});

test("a db_error terminal transition maps to HTTP 500", async () => {
  assert.equal(await acknowledgeTerminal(1, 101, "db_error"), 500);
});

test("a lost claim confirmed PROCESSED on the ledger is acknowledged with 200", async () => {
  const status = await acknowledgeTerminal(
    1,
    102,
    "lost",
    readerReturning({ status: "PROCESSED" })
  );

  assert.equal(status, 200);
});

test("a lost claim whose ledger row is PROCESSING returns retryable 503", async () => {
  const status = await acknowledgeTerminal(
    1,
    103,
    "lost",
    readerReturning({ status: "PROCESSING" })
  );

  assert.equal(status, 503);
});

test("a lost claim whose ledger row is FAILED returns retryable 503", async () => {
  const status = await acknowledgeTerminal(
    1,
    104,
    "lost",
    readerReturning({ status: "FAILED" })
  );

  assert.equal(status, 503);
});

test("a lost claim with no ledger row returns retryable 503", async () => {
  const status = await acknowledgeTerminal(
    1,
    105,
    "lost",
    readerReturning(null)
  );

  assert.equal(status, 503);
});

test("a failed confirmation read after a lost claim returns retryable 503, never 200", async () => {
  const status = await acknowledgeTerminal(
    1,
    106,
    "lost",
    failingReader()
  );

  assert.equal(status, 503);
});

// ── Conversation-create race classification (narrow retry predicate) ────────

function p2002(target: unknown) {
  return Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
    meta: { target },
  });
}

test("a P2002 on the Conversation compound index (field-array target) is the retryable create race", () => {
  const err = p2002([
    "sellerId",
    "platform",
    "externalUserId",
    "externalThreadId",
  ]);

  assert.equal(isConversationCreateRace(err), true);
});

test("a field-array target in a different order is still the create race", () => {
  const err = p2002([
    "externalThreadId",
    "externalUserId",
    "platform",
    "sellerId",
  ]);

  assert.equal(isConversationCreateRace(err), true);
});

test("a P2002 naming the Conversation compound constraint (string target) is the retryable create race", () => {
  const err = p2002(
    "Conversation_sellerId_platform_externalUserId_externalThreadId_key"
  );

  assert.equal(isConversationCreateRace(err), true);
});

test("a P2002 on any other index is NOT classified as the conversation race", () => {
  const messageDup = p2002(["conversationId", "externalMessageId"]);
  const ledgerDup = p2002(["sellerId", "updateId"]);
  const messageConstraint = p2002(
    "Message_conversationId_externalMessageId_key"
  );

  assert.equal(isConversationCreateRace(messageDup), false);
  assert.equal(isConversationCreateRace(ledgerDup), false);
  assert.equal(isConversationCreateRace(messageConstraint), false);
});

test("a partial field-array target (externalUserId + externalThreadId only) is NOT the race", () => {
  assert.equal(
    isConversationCreateRace(p2002(["externalUserId", "externalThreadId"])),
    false
  );
});

test("a field-array target missing sellerId or platform is NOT the race", () => {
  assert.equal(
    isConversationCreateRace(
      p2002(["platform", "externalUserId", "externalThreadId"])
    ),
    false
  );
  assert.equal(
    isConversationCreateRace(
      p2002(["sellerId", "externalUserId", "externalThreadId"])
    ),
    false
  );
});

test("a field-array target with unrelated extra fields is NOT the race", () => {
  assert.equal(
    isConversationCreateRace(
      p2002([
        "sellerId",
        "platform",
        "externalUserId",
        "externalThreadId",
        "conversationId",
      ])
    ),
    false
  );
});

test("a partial or unrelated string target is NOT the race", () => {
  assert.equal(
    isConversationCreateRace(
      p2002("Conversation_externalUserId_externalThreadId_key")
    ),
    false
  );
  assert.equal(
    isConversationCreateRace(
      p2002("Message_sellerId_platform_externalUserId_externalThreadId_key")
    ),
    false
  );
  assert.equal(isConversationCreateRace(p2002("Conversation_sellerId_key")), false);
});

test("a P2002 without a usable target is NOT classified as the conversation race", () => {
  assert.equal(isConversationCreateRace(p2002(undefined)), false);
  assert.equal(isConversationCreateRace(p2002(null)), false);
  assert.equal(isConversationCreateRace(p2002(42)), false);
});

test("non-P2002 errors are never classified as the conversation race", () => {
  assert.equal(isConversationCreateRace(new Error("connection reset")), false);
  assert.equal(isConversationCreateRace({ code: "P2003" }), false);
  assert.equal(isConversationCreateRace(null), false);
});

test("the conversation-create retry budget is bounded and small", () => {
  assert.ok(
    Number.isInteger(CONVERSATION_CREATE_RETRY_ATTEMPTS) &&
      CONVERSATION_CREATE_RETRY_ATTEMPTS > 0 &&
      CONVERSATION_CREATE_RETRY_ATTEMPTS <= 5,
    "retries must be a small bounded number"
  );
});

// ── Placeholder-reply regression ───────────────────────────────────────────

test("the placeholder auto-reply no longer exists in the controller source", async (t) => {
  const source = findControllerSource();

  if (source === null) {
    // Source file unreachable (e.g. running from dist without a src
    // checkout): skip the scan explicitly so it is reported as
    // skipped, never as passed.
    return t.skip("controller source not reachable from this run location");
  }

  assert.ok(
    !source.includes("Got your message"),
    "the placeholder Telegram auto-reply must not exist"
  );
});

test("the controller never imports the Telegram send service", async (t) => {
  const source = findControllerSource();

  if (source === null) {
    return t.skip("controller source not reachable from this run location");
  }

  assert.ok(!source.includes("sendTelegramMessage"));
  assert.ok(!source.includes("telegram.service"));
});

test("non-text placeholders document that no media bytes are persisted", async (t) => {
  const source = findControllerSource();

  if (source === null) {
    return t.skip("controller source not reachable from this run location");
  }

  // The controller must document that media files are not downloaded or
  // stored; only the textual placeholder is persisted. The check is
  // case-insensitive so it does not depend on comment capitalization.
  assert.ok(source.toLowerCase().includes("media files are not downloaded"));
  assert.ok(!source.includes("getFile"));
  assert.ok(!source.includes("file_id"));
});

test("all terminal paths use the shared acknowledgeTerminal policy", async (t) => {
  const source = findControllerSource();

  if (source === null) {
    return t.skip("controller source not reachable from this run location");
  }

  // Bot-message, unsupported-update, and defensive fallback paths must
  // all route through the shared acknowledgeTerminal policy — no
  // branch may return a blind 200 for a lost or failed transition.
  const routedCalls = source.split("await acknowledgeTerminal(").length - 1;
  assert.ok(
    routedCalls >= 3,
    `bot / unsupported / fallback paths must all call acknowledgeTerminal (found ${routedCalls})`
  );
});
