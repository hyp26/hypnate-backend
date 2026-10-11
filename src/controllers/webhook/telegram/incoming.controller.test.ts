import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  classifyTelegramUpdate,
  decideClaimAction,
  resolveInboundText,
  isReclaimEligible,
  ownsClaim,
  simulateReclaimRace,
  countEffectsAfterProcessed,
  TELEGRAM_CLAIM_STALE_MS,
} from "./incoming.controller";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  assert.equal(noChat.updateId, null);
  assert.equal(noMessageId.kind, "malformed");
  assert.equal(noMessageId.updateId, null);
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

test("non-text placeholders document that no media bytes are persisted", () => {
  const source = readFileSync(
    join(__dirname, "incoming.controller.ts"),
    "utf8"
  );

  // The controller must document that media files are not downloaded or
  // stored; only the textual placeholder is persisted.
  assert.ok(source.includes("media files are NOT downloaded"));
  assert.ok(!source.includes("getFile"));
  assert.ok(!source.includes("file_id"));
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

// ── Competing claims during reclamation (atomic race) ────────────────────────

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

test("a stale PROCESSING row is also reclaimed by exactly one worker", () => {
  const now = new Date("2026-10-11T12:00:00Z");
  const staleRow = {
    status: "PROCESSING",
    updatedAt: new Date(now.getTime() - TELEGRAM_CLAIM_STALE_MS - 5000),
    claimToken: "crashed-worker",
  };

  const outcomes = simulateReclaimRace(staleRow, 3, now);

  assert.equal(outcomes.filter((o) => o === "owned").length, 1);
  assert.equal(outcomes.filter((o) => o === "busy").length, 2);
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

// ── Simultaneous duplicate deliveries ───────────────────────────────────────

test("simultaneous duplicates of an unclaimed update resolve to one owner", () => {
  // First delivery creates the row (owned); simultaneous duplicates hit the
  // unique index and observe a fresh PROCESSING row → busy, never reprocess.
  const now = new Date("2026-10-11T12:00:00Z");

  // Model a fresh row created by the first delivery.
  const fresh = {
    status: "PROCESSING",
    updatedAt: now,
    claimToken: "first-delivery",
  };

  const outcomes = simulateReclaimRace(fresh, 3, now);

  assert.equal(outcomes.filter((o) => o === "owned").length, 0);
  assert.ok(outcomes.every((o) => o === "busy"));
});

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

// ── Transaction failure and retry ───────────────────────────────────────────

test("a transaction failure leaves the claim FAILED and reclaimable by retry", () => {
  const now = new Date("2026-10-11T12:00:00Z");

  // A crashed transaction marks its claim FAILED (fenced)...
  const failed = {
    status: "FAILED",
    updatedAt: now,
    claimToken: "crashed-attempt",
  };

  // ...and Telegram's retry reclaims it exactly once.
  const outcomes = simulateReclaimRace(failed, 2, now);

  assert.equal(outcomes[0], "owned");
  assert.equal(outcomes[1], "busy");
  assert.equal(isReclaimEligible("FAILED", now, now), true);
});

test("repeated FAILED attempts recover on each retry without double-owning", () => {
  const now = new Date("2026-10-11T12:00:00Z");

  // First retry succeeds but fails mid-transaction again → FAILED again.
  let row = {
    status: "FAILED",
    updatedAt: new Date(now.getTime() - 120_000),
    claimToken: "attempt-1",
  };

  const first = simulateReclaimRace(row, 1, now);
  assert.equal(first[0], "owned");

  // It fails again → next retry cycle also yields exactly one owner.
  row = {
    status: "FAILED",
    updatedAt: new Date(now.getTime() - 60_000),
    claimToken: "attempt-2",
  };

  const second = simulateReclaimRace(row, 2, now);
  assert.equal(second.filter((o) => o === "owned").length, 1);
  assert.equal(second.filter((o) => o === "busy").length, 1);
});

// ── Placeholder-reply regression ───────────────────────────────────────────

test("the placeholder auto-reply no longer exists in the controller source", () => {
  const source = readFileSync(
    join(__dirname, "incoming.controller.ts"),
    "utf8"
  );

  assert.ok(
    !source.includes("Got your message"),
    "the placeholder Telegram auto-reply must not exist"
  );
});

test("the controller never imports the Telegram send service", () => {
  // The webhook must not send unsolicited outbound messages.
  const source = readFileSync(
    join(__dirname, "incoming.controller.ts"),
    "utf8"
  );

  assert.ok(!source.includes("sendTelegramMessage"));
  assert.ok(!source.includes("telegram.service"));
});
