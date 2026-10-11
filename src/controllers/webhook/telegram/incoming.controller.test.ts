import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  classifyTelegramUpdate,
  decideClaimAction,
  resolveInboundText,
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

// ── Claim decision ─────────────────────────────────────────────────────────

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
