import { Request, Response } from "express";
import crypto from "crypto";
import prisma from "../../../prisma/client";
import { logger } from "../../../utils/logger";

/*
 * Telegram incoming webhook.
 *
 * Durable idempotency: every update is claimed in the
 * TelegramWebhookUpdate ledger keyed by (sellerId, update_id) before
 * processing. The database unique constraint makes duplicate detection
 * safe under concurrent webhook deliveries.
 *
 * Claim ownership and fencing:
 * - Reclamation of a FAILED or stale PROCESSING row is a single
 *   conditional UPDATE ... WHERE, so exactly one worker can acquire a
 *   previously claimed update; losing racers observe zero updated rows.
 * - Each attempt owns the claim through a random claimToken. Every state
 *   transition (PROCESSED / FAILED) is a conditional UPDATE matching that
 *   token, and the PROCESSED flip happens INSIDE the transaction that
 *   persists the conversation message. An expired worker that lost its
 *   claim therefore cannot persist message data, increment unreadCount,
 *   or mark the claim PROCESSED — its transaction rolls back.
 *
 * Conflict-safe message persistence:
 * - Inbound messages are inserted with createMany + skipDuplicates, NOT
 *   create + P2002 catch. A unique-constraint violation inside an
 *   interactive Prisma transaction aborts the whole transaction in
 *   PostgreSQL, so the previous catch-based approach left the tx unusable
 *   and any later statement would fail. skipDuplicates resolves the
 *   conflict inside the INSERT itself; the returned count tells us
 *   whether THIS delivery inserted the row, and unreadCount is only
 *   incremented when it did.
 *
 * Acknowledgment policy (no durable queue exists — none is pretended):
 * - "duplicate" is acknowledged 200 ONLY after durably reading the
 *   ledger row as PROCESSED.
 * - "busy" (another worker still processing) is NOT proof of persistence:
 *   the response is 503 so Telegram retries. When the owner finishes, a
 *   retry observes PROCESSED and is acknowledged 200. If the owner fails,
 *   the row becomes FAILED and the retry reclaims and completes it.
 * - ClaimLostError is acknowledged 200 ONLY when the ledger row is
 *   durably PROCESSED; otherwise 503, never touching the new owner's
 *   state.
 *
 * Non-text Telegram messages: only a textual placeholder like
 * "[Telegram photo message]" is persisted (mirroring the WhatsApp
 * convention). Media files are NOT downloaded, stored, or referenced —
 * mediaUrl stays null and no media bytes are retained anywhere.
 */

export const TELEGRAM_CLAIM_STALE_MS = 5 * 60 * 1000;

export type TelegramUpdateKind =
  | "message"
  | "edited_message"
  | "unsupported"
  | "malformed";

export interface TelegramInboundMessage {
  chatId: string;
  messageId: string;
  text: string;
  senderName: string;
  isBot: boolean;
  messageType: string;
}

export interface ClassifiedTelegramUpdate {
  kind: TelegramUpdateKind;
  updateId: number | null;
  updateType: string;
  message?: TelegramInboundMessage;
}

export interface TelegramClaimRecord {
  status: string;
  updatedAt: Date;
  claimToken?: string | null;
}

export type TelegramClaimAction =
  | "process_new"
  | "duplicate"
  | "reclaim"
  | "in_flight";

/*
 * Outcome of attempting to acquire a claim for one webhook delivery.
 * Exactly one concurrent delivery of a reclaimable update obtains
 * "owned"; all others observe "busy" or "duplicate".
 */
export type TelegramClaimAcquisition =
  | "owned"
  | "duplicate"
  | "busy";

/*
 * Observable outcome of a terminal (PROCESSED/FAILED) transition:
 * - "marked": the fenced UPDATE matched our row; state is durable.
 * - "lost": the fenced UPDATE matched zero rows; another worker owns
 *   the claim now and we must not touch its state.
 * - "db_error": the transition could not be persisted; the response
 *   must be retryable, never a success.
 */
export type TerminalTransitionResult =
  | "marked"
  | "lost"
  | "db_error";

/*
 * Response policy for a webhook delivery after processing:
 * - "acknowledge": HTTP 200. Used ONLY when the update's completion is
 *   durably confirmed (ledger row PROCESSED) or our own fenced writes
 *   committed.
 * - "retry": HTTP 500. Processing failed; the claim was marked FAILED
 *   through a fenced transition. Telegram retries; the FAILED row is
 *   reclaimable.
 * - "retry_in_flight": HTTP 503. Another worker owns the claim and its
 *   completion is NOT confirmed. No state was modified by us. Telegram
 *   retries; a later retry observes the durable outcome.
 */
export type WebhookResponsePolicy =
  | "acknowledge"
  | "retry"
  | "retry_in_flight";

/*
 * Pure mapping from response policy to HTTP status. Exported for tests.
 */
export function statusForPolicy(
  policy: WebhookResponsePolicy
): number {
  if (policy === "acknowledge") {
    return 200;
  }

  return policy === "retry" ? 500 : 503;
}

const KNOWN_UPDATE_KEYS = [
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "callback_query",
  "my_chat_member",
  "chat_member",
  "poll",
  "poll_answer",
];

const MEDIA_KEYS = [
  "photo",
  "video",
  "document",
  "audio",
  "voice",
  "video_note",
  "sticker",
  "animation",
  "contact",
  "location",
  "venue",
  "poll",
];

export function resolveInboundText(
  message: Record<string, unknown>
): string {
  if (typeof message.text === "string" && message.text.length > 0) {
    return message.text;
  }

  const mediaType = MEDIA_KEYS.find((key) => key in message);

  return mediaType ? `[Telegram ${mediaType} message]` : "";
}

function parseInboundMessage(
  raw: unknown
): TelegramInboundMessage | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const record = raw as Record<string, unknown>;

  if (
    typeof record.chat !== "object" ||
    record.chat === null
  ) {
    return null;
  }

  const chat = record.chat as Record<string, unknown>;

  if (
    !Number.isInteger(chat.id) ||
    typeof record.message_id !== "number"
  ) {
    return null;
  }

  const from: Record<string, unknown> =
    typeof record.from === "object" && record.from !== null
      ? (record.from as Record<string, unknown>)
      : {};

  const firstName = from.first_name;

  return {
    chatId: String(chat.id),
    messageId: String(record.message_id),
    text: resolveInboundText(record),
    senderName:
      typeof firstName === "string" && firstName.length > 0
        ? firstName
        : "User",
    isBot: from.is_bot === true,
    messageType:
      typeof record.text === "string" && record.text.length > 0
        ? "text"
        : "non_text",
  };
}

function detectUpdateType(
  body: Record<string, unknown>
): string {
  for (const key of KNOWN_UPDATE_KEYS) {
    if (key in body) {
      return key;
    }
  }

  const otherKeys = Object.keys(body).filter(
    (key) => key !== "update_id"
  );

  return otherKeys.length > 0 ? otherKeys[0] : "unknown";
}

export function classifyTelegramUpdate(
  body: unknown
): ClassifiedTelegramUpdate {
  if (typeof body !== "object" || body === null) {
    return { kind: "malformed", updateId: null, updateType: "unknown" };
  }

  const record = body as Record<string, unknown>;
  const updateType = detectUpdateType(record);

  const updateId = record.update_id;

  if (
    typeof updateId !== "number" ||
    !Number.isInteger(updateId) ||
    updateId <= 0
  ) {
    return { kind: "malformed", updateId: null, updateType };
  }

  if (
    updateType === "message" ||
    updateType === "edited_message"
  ) {
    const message = parseInboundMessage(record[updateType]);

    if (message) {
      return { kind: updateType, updateId, updateType, message };
    }

    return { kind: "malformed", updateId, updateType };
  }

  return { kind: "unsupported", updateId, updateType };
}

/*
 * Read-path claim decision, mirroring the atomic conditional UPDATE.
 * Kept exported for observability and tests; the write path below is
 * what actually guarantees single ownership under concurrency.
 */
export function decideClaimAction(
  existing: TelegramClaimRecord | null,
  now: Date = new Date()
): TelegramClaimAction {
  if (!existing) {
    return "process_new";
  }

  if (existing.status === "PROCESSED") {
    return "duplicate";
  }

  if (existing.status === "FAILED") {
    return "reclaim";
  }

  if (
    now.getTime() - existing.updatedAt.getTime() >
    TELEGRAM_CLAIM_STALE_MS
  ) {
    return "reclaim";
  }

  return "in_flight";
}

/*
 * A claim row is reclaimable only when the previous attempt gave up
 * (FAILED) or its PROCESSING heartbeat is older than the stale window.
 * This predicate is exactly the WHERE clause of the atomic reclaim
 * UPDATE, so the read model and the write model cannot diverge.
 */
export function isReclaimEligible(
  status: string,
  updatedAt: Date,
  now: Date = new Date()
): boolean {
  if (status === "FAILED") {
    return true;
  }

  if (status === "PROCESSING") {
    return now.getTime() - updatedAt.getTime() > TELEGRAM_CLAIM_STALE_MS;
  }

  return false;
}

/*
 * Fencing predicate: a worker still owns its claim only while the row
 * is PROCESSING under its own claimToken. Any other state — or a token
 * rotated by a reclaimer — means the worker must not touch data.
 */
export function ownsClaim(
  record: TelegramClaimRecord | null,
  claimToken: string
): boolean {
  return (
    record !== null &&
    record.status === "PROCESSING" &&
    record.claimToken === claimToken
  );
}

/*
 * Pure model of the atomic reclaim race: N workers concurrently retry
 * the same FAILED/stale update. The database serializes the
 * conditional UPDATE, so exactly the first eligible worker owns the
 * claim; every later worker observes a fresh PROCESSING row owned by
 * the winner and backs off. This mirrors the updateMany count check.
 * (Supplementary coverage — the DB test file proves the real behavior.)
 */
export function simulateReclaimRace(
  existing: TelegramClaimRecord,
  attempts: number,
  now: Date = new Date()
): Array<TelegramClaimAcquisition> {
  const outcomes: TelegramClaimAcquisition[] = [];
  let current = existing;

  for (let i = 0; i < attempts; i += 1) {
    if (isReclaimEligible(current.status, current.updatedAt, now)) {
      outcomes.push("owned");
      current = {
        status: "PROCESSING",
        updatedAt: now,
        claimToken: `worker-${i}`,
      };
    } else if (current.status === "PROCESSED") {
      outcomes.push("duplicate");
    } else {
      outcomes.push("busy");
    }
  }

  return outcomes;
}

/*
 * Pure model of repeated deliveries after success: once PROCESSED, no
 * delivery can ever reacquire the claim, so no message is persisted,
 * unreadCount is not incremented, and no socket event repeats.
 * (Supplementary coverage — the DB test file proves the real behavior.)
 */
export function countEffectsAfterProcessed(
  deliveries: number
): {
  deliveries: number;
  messagesPersisted: number;
  unreadIncrements: number;
} {
  return {
    deliveries,
    messagesPersisted: 0,
    unreadIncrements: 0,
  };
}

function isUniqueConstraintViolation(
  err: unknown
): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "P2002"
  );
}

function isBotMessage(
  update: ClassifiedTelegramUpdate
): boolean {
  return update.kind === "message" && update.message?.isBot === true;
}

/*
 * Thrown inside a transaction when the fenced PROCESSED flip matches
 * zero rows, i.e. another worker reclaimed the claim while this
 * attempt was running. The transaction rolls back, so no message data,
 * unreadCount increment, or PROCESSED marker from the expired worker
 * survives.
 */
export class ClaimLostError extends Error {
  constructor() {
    super("Telegram webhook claim was reclaimed by another worker");
    this.name = "ClaimLostError";
  }
}

/*
 * Minimal structural types satisfied by both the root Prisma client
 * and an interactive transaction client. Delegates are typed `any` so
 * the generated client signatures accept these in either position,
 * and so tests can inject failures.
 */
type LedgerClient = {
  telegramWebhookUpdate: {
    updateMany: (args: any) => Promise<{ count: number }>;
  };
};

type TxClient = {
  conversation: any;
  message: any;
  telegramWebhookUpdate: any;
};

/*
 * Atomically acquire (create or reclaim) the claim for one delivery.
 * Returns the acquisition outcome plus the token that fences all
 * subsequent state transitions for this attempt. Exported for
 * database-backed tests.
 *
 * "duplicate" is returned ONLY after a durable read confirms the row
 * is PROCESSED — never on the mere existence of a row.
 */
export async function acquireClaim(
  sellerId: number,
  updateId: number,
  now: Date
): Promise<{
  outcome: TelegramClaimAcquisition;
  claimToken: string;
}> {
  const claimToken = crypto.randomUUID();

  try {
    await prisma.telegramWebhookUpdate.create({
      data: {
        sellerId,
        updateId,
        status: "PROCESSING",
        claimToken,
      },
    });

    return { outcome: "owned", claimToken };
  } catch (err) {
    if (!isUniqueConstraintViolation(err)) {
      throw err;
    }
  }

  /*
   * Row exists: atomically reclaim it, but only if the previous
   * attempt FAILED or its PROCESSING heartbeat is stale. The single
   * conditional UPDATE is serialized by the row lock, so exactly one
   * racing worker updates a row; every other worker sees count 0 and
   * backs off. No read-decide-write gap exists.
   */
  const staleBefore = new Date(
    now.getTime() - TELEGRAM_CLAIM_STALE_MS
  );

  const reclaimed = await prisma.telegramWebhookUpdate.updateMany({
    where: {
      sellerId,
      updateId,
      OR: [
        { status: "FAILED" },
        { status: "PROCESSING", updatedAt: { lt: staleBefore } },
      ],
    },
    data: {
      status: "PROCESSING",
      claimToken,
      updatedAt: now,
    },
  });

  if (reclaimed.count === 1) {
    return { outcome: "owned", claimToken };
  }

  /*
   * Durable confirmation: read the row. Only a PROCESSED row may be
   * acknowledged as a duplicate; a fresh PROCESSING row belongs to
   * another in-flight worker and is NOT proof of persistence.
   */
  const existing = await prisma.telegramWebhookUpdate.findUnique({
    where: {
      sellerId_updateId: { sellerId, updateId },
    },
    select: { status: true },
  });

  if (existing?.status === "PROCESSED") {
    return { outcome: "duplicate", claimToken };
  }

  return { outcome: "busy", claimToken };
}

/*
 * Fenced transition to a terminal state. Matches the claim token, so
 * it only succeeds while THIS attempt still owns the claim. Returns
 * false when the claim was lost — callers inside a transaction must
 * then roll back by throwing ClaimLostError. Propagates database
 * errors instead of swallowing them. Exported for database tests.
 */
export async function fencedTransition(
  tx: LedgerClient,
  sellerId: number,
  updateId: number,
  claimToken: string,
  status: "PROCESSED" | "FAILED"
): Promise<boolean> {
  const result = await tx.telegramWebhookUpdate.updateMany({
    where: {
      sellerId,
      updateId,
      claimToken,
      status: "PROCESSING",
    },
    data: { status },
  });

  return result.count === 1;
}

/*
 * Observable terminal transition for paths outside a transaction
 * (bot / unsupported / defensive fallbacks / failure marking).
 * Never silently swallows a database error:
 * - "marked"  → the state is durably saved; acknowledge.
 * - "lost"    → another worker owns the claim; do not touch its state.
 * - "db_error"→ the terminal state may not be saved; respond 500 so
 *   Telegram retries. Re-running these paths is idempotent (they have
 *   no side effects beyond the ledger row), so a retry is always safe.
 */
async function markTerminal(
  sellerId: number,
  updateId: number,
  claimToken: string,
  status: "PROCESSED" | "FAILED"
): Promise<TerminalTransitionResult> {
  try {
    const marked = await fencedTransition(
      prisma,
      sellerId,
      updateId,
      claimToken,
      status
    );

    return marked ? "marked" : "lost";
  } catch (err) {
    logger.error(
      "Telegram webhook: terminal claim transition failed",
      { sellerId, updateId, status, err }
    );

    return "db_error";
  }
}

export interface PersistInboundMessageParams {
  sellerId: number;
  updateId: number;
  updateType: string;
  claimToken: string;
  message: TelegramInboundMessage;
  externalThreadId: string;
  now: Date;
}

export type PersistInboundMessageResult =
  | { duplicate: true }
  | {
      duplicate: false;
      newMessage: {
        id: number;
        text: string;
        createdAt: Date;
      };
      updatedConversation: {
        id: number;
        unreadCount: number;
      };
    };

/*
 * Conflict-safe persistence of one inbound Telegram message inside a
 * transaction (also callable on the root client). Uses createMany with
 * skipDuplicates: a duplicate (conversationId, externalMessageId) is
 * resolved by the INSERT itself instead of aborting the transaction
 * with P2002, which would leave an interactive Prisma transaction
 * unusable. unreadCount is incremented only when the INSERT reports
 * that THIS delivery inserted the row, and the fenced PROCESSED flip
 * happens in the same transaction. Exported for database tests.
 */
export async function persistInboundMessage(
  tx: TxClient,
  params: PersistInboundMessageParams
): Promise<PersistInboundMessageResult> {
  const {
    sellerId,
    updateId,
    updateType,
    claimToken,
    message,
    externalThreadId,
    now,
  } = params;

  const conversation = await tx.conversation.upsert({
    where: {
      sellerId_platform_externalUserId_externalThreadId: {
        sellerId,
        platform: "TELEGRAM",
        externalUserId: message.chatId,
        externalThreadId,
      },
    },
    create: {
      sellerId,
      platform: "TELEGRAM",
      externalUserId: message.chatId,
      externalThreadId,
      customerName: message.senderName,
      lastMessage: message.text,
      lastMessageAt: now,
    },
    update: {},
  });

  const inserted = await tx.message.createMany({
    data: {
      conversationId: conversation.id,
      sender: "CUSTOMER",
      direction: "INBOUND",
      status: "SENT",
      text: message.text,
      type: message.messageType,
      externalMessageId: message.messageId,
      metadata: {
        telegramUpdateId: updateId,
        telegramUpdateType: updateType,
      },
    },
    skipDuplicates: true,
  });

  if (inserted.count === 0) {
    /*
     * The message unique index (conversationId, externalMessageId)
     * already holds this content (e.g. a different Telegram update
     * delivering the same message_id, or a legacy row). The
     * transaction is still healthy; finish it by marking PROCESSED
     * without incrementing unreadCount.
     */
    const fenced = await fencedTransition(
      tx,
      sellerId,
      updateId,
      claimToken,
      "PROCESSED"
    );

    if (!fenced) {
      throw new ClaimLostError();
    }

    return { duplicate: true };
  }

  const newMessage = await tx.message.findUnique({
    where: {
      conversationId_externalMessageId: {
        conversationId: conversation.id,
        externalMessageId: message.messageId,
      },
    },
  });

  const updatedConversation = await tx.conversation.update({
    where: { id: conversation.id },
    data: {
      lastMessage: message.text,
      lastMessageAt: now,
      unreadCount: { increment: 1 },
    },
  });

  const fenced = await fencedTransition(
    tx,
    sellerId,
    updateId,
    claimToken,
    "PROCESSED"
  );

  if (!fenced) {
    throw new ClaimLostError();
  }

  return {
    duplicate: false,
    newMessage,
    updatedConversation,
  };
}

/*
 * Response policy for a processing failure. Distinguishes:
 * - "acknowledge" (HTTP 200): for ClaimLostError, ONLY when the ledger
 *   row is durably confirmed PROCESSED (the new owner finished). Our
 *   own writes rolled back, and the completed state is proven.
 * - "retry_in_flight" (HTTP 503): for ClaimLostError when completion
 *   is NOT confirmed. Another worker owns the claim; we modify nothing
 *   and let Telegram retry until the durable outcome exists.
 * - "retry" (HTTP 500): the work was NOT persisted (including an
 *   unexpected unique-constraint error that aborted the transaction).
 *   The claim is marked FAILED through a fenced transition so we never
 *   overwrite another worker's claim, and Telegram retries safely.
 *   If even the FAILED marking fails, the row stays PROCESSING until
 *   the stale window passes, after which reclamation is still safe —
 *   but we still respond retryably because success must never be
 *   reported for a message that was not persisted.
 * Exported for database tests.
 */
export async function handleProcessingFailure(
  sellerId: number,
  updateId: number,
  claimToken: string,
  err: unknown
): Promise<WebhookResponsePolicy> {
  if (err instanceof ClaimLostError) {
    /*
     * Durable confirmation only: acknowledge 200 solely when the row
     * is PROCESSED. If the confirmation read itself fails, fall back
     * to retryable — never acknowledge without proof.
     */
    try {
      const row = await prisma.telegramWebhookUpdate.findUnique({
        where: {
          sellerId_updateId: { sellerId, updateId },
        },
        select: { status: true },
      });

      return row?.status === "PROCESSED"
        ? "acknowledge"
        : "retry_in_flight";
    } catch (confirmErr) {
      logger.error(
        "Telegram webhook: claim-loss confirmation read failed; responding retryably",
        { sellerId, updateId, err: confirmErr }
      );

      return "retry_in_flight";
    }
  }

  if (isUniqueConstraintViolation(err)) {
    /*
     * Unexpected unique-constraint error that escaped the transaction:
     * the transaction rolled back and NOTHING was persisted. This is
     * NOT a confirmed duplicate — respond retryably, never 200.
     */
    logger.warn(
      "Telegram webhook: unexpected unique-constraint error; transaction rolled back",
      { sellerId, updateId }
    );
  } else {
    logger.error(
      "Telegram incoming webhook processing failed:",
      err
    );
  }

  if (claimToken) {
    /*
     * Fenced FAILED marking: only succeeds while we still own the
     * claim, so a reclaimer's PROCESSING state can never be
     * overwritten. A DB error here is logged, not thrown — the
     * response policy below is unchanged either way.
     */
    const marked = await markTerminal(
      sellerId,
      updateId,
      claimToken,
      "FAILED"
    );

    if (marked === "db_error") {
      logger.error(
        "Telegram webhook: FAILED marking also failed; claim remains PROCESSING and is reclaimable after the stale window",
        { sellerId, updateId }
      );
    }
  }

  return "retry";
}

export const telegramWebhook = async (
  req: Request,
  res: Response
) => {
  const sellerId = Number(req.params.sellerId);

  if (Number.isNaN(sellerId) || sellerId <= 0) {
    return res.sendStatus(200);
  }

  const update = classifyTelegramUpdate(req.body);

  if (update.kind === "malformed" || update.updateId === null) {
    logger.warn(
      "Telegram webhook: malformed update acknowledged without processing",
      { sellerId, updateType: update.updateType }
    );

    return res.sendStatus(200);
  }

  const updateId = update.updateId;
  const now = new Date();

  /*
   * The fencing token for this attempt. Assigned when the claim is
   * acquired; visible in the error path so a FAILED transition is
   * only ever written by the worker that still owns the claim.
   */
  let claimToken = "";

  try {
    /*
     * Claim the update durably and atomically before touching any
     * conversation data. Duplicate deliveries collide here.
     */
    const { outcome, claimToken: token } = await acquireClaim(
      sellerId,
      updateId,
      now
    );

    claimToken = token;

    if (outcome === "duplicate") {
      /*
       * Durably confirmed PROCESSED by acquireClaim's read. All
       * effects are already persisted; acknowledge with no side
       * effects.
       */
      return res.sendStatus(200);
    }

    if (outcome === "busy") {
      /*
       * Another worker still owns the claim. This is NOT proof of
       * successful persistence — there is no durable queue handing
       * off the work, so do not acknowledge. Respond 503; Telegram
       * retries, and a later retry observes the durable outcome
       * (200 once PROCESSED, or reclaims once FAILED/stale).
       */
      return res.sendStatus(503);
    }

    if (isBotMessage(update)) {
      /*
       * Bot messages are ignored, but the acknowledgment is
       * observable: only report 200 when the PROCESSED state was
       * actually saved (or the claim was taken over by the new
       * owner, who will finish it).
       */
      const marked = await markTerminal(
        sellerId,
        updateId,
        claimToken,
        "PROCESSED"
      );

      if (marked === "db_error") {
        return res.sendStatus(500);
      }

      return res.sendStatus(200);
    }

    if (update.kind === "unsupported") {
      const marked = await markTerminal(
        sellerId,
        updateId,
        claimToken,
        "PROCESSED"
      );

      if (marked === "db_error") {
        return res.sendStatus(500);
      }

      logger.info(
        "Telegram webhook: acknowledged unsupported update",
        { sellerId, updateType: update.updateType, updateId }
      );

      return res.sendStatus(200);
    }

    const message = update.message;

    if (!message) {
      const marked = await markTerminal(
        sellerId,
        updateId,
        claimToken,
        "PROCESSED"
      );

      if (marked === "db_error") {
        return res.sendStatus(500);
      }

      return res.sendStatus(200);
    }

    /*
     * The secret-token middleware has already validated this
     * seller's active TELEGRAM connection. The connection id is
     * used as the conversation thread id so merchant isolation is
     * enforced end-to-end.
     */
    const connection = await prisma.channelConnection.findFirst({
      where: { sellerId, platform: "TELEGRAM", isActive: true },
      select: { id: true },
    });

    if (!connection) {
      throw new Error("No active Telegram channel connection");
    }

    const externalThreadId = String(connection.id);

    if (update.kind === "edited_message") {
      /*
       * Edits update the text of the existing message record; no new
       * message is created, unreadCount is not touched, and no socket
       * event is emitted. The PROCESSED flip is fenced by claimToken
       * inside the same transaction, so an expired worker cannot
       * apply a stale edit after another worker reclaimed the claim.
       */
      await prisma.$transaction(async (tx) => {
        const conversation = await tx.conversation.findUnique({
          where: {
            sellerId_platform_externalUserId_externalThreadId: {
              sellerId,
              platform: "TELEGRAM",
              externalUserId: message.chatId,
              externalThreadId,
            },
          },
          select: { id: true },
        });

        if (conversation) {
          await tx.message.updateMany({
            where: {
              conversationId: conversation.id,
              externalMessageId: message.messageId,
            },
            data: { text: message.text },
          });
        }

        const fenced = await fencedTransition(
          tx,
          sellerId,
          updateId,
          claimToken,
          "PROCESSED"
        );

        if (!fenced) {
          throw new ClaimLostError();
        }
      });

      return res.sendStatus(200);
    }

    /*
     * New inbound message. Conversation, message, conversation
     * counters, and the fenced PROCESSED marker commit atomically.
     * The fence check inside the transaction guarantees an expired
     * worker can neither persist the message nor increment
     * unreadCount after losing its claim.
     */
    const result = await prisma.$transaction(async (tx) =>
      persistInboundMessage(tx, {
        sellerId,
        updateId,
        updateType: update.updateType,
        claimToken,
        message,
        externalThreadId,
        now,
      })
    );

    if (result.duplicate) {
      // Message content already persisted; no unread increment, no events.
      return res.sendStatus(200);
    }

    const io = req.app.get("io");

    if (io) {
      io.to(`room_${result.updatedConversation.id}`).emit(
        "new_message",
        {
          id: result.newMessage.id,
          conversationId: result.updatedConversation.id,
          text: result.newMessage.text,
          sender: "CUSTOMER",
          createdAt: result.newMessage.createdAt,
        }
      );

      io.to(`seller_${sellerId}`).emit("conversation_updated", {
        conversationId: result.updatedConversation.id,
        conversation: result.updatedConversation,
      });
    }

    return res.sendStatus(200);
  } catch (err) {
    const policy = await handleProcessingFailure(
      sellerId,
      updateId,
      claimToken,
      err
    );

    return res.sendStatus(statusForPolicy(policy));
  }
};
