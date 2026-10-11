import { Request, Response } from "express";
import prisma from "../../../prisma/client";
import { logger } from "../../../utils/logger";

/*
 * Telegram incoming webhook.
 *
 * Durable idempotency: every update is claimed in the
 * TelegramWebhookUpdate ledger keyed by (sellerId, update_id) before
 * processing. The database unique constraint makes duplicate detection
 * safe under concurrent webhook deliveries. A row only reaches PROCESSED
 * inside the same transaction that persists the conversation message, so
 * an interrupted attempt never looks complete. Failed attempts are marked
 * FAILED so a Telegram retry can reclaim them.
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
}

export type TelegramClaimAction =
  | "process_new"
  | "duplicate"
  | "reclaim"
  | "in_flight";

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

async function markUpdate(
  sellerId: number,
  updateId: number,
  status: string
): Promise<void> {
  await prisma.telegramWebhookUpdate.update({
    where: {
      sellerId_updateId: { sellerId, updateId },
    },
    data: { status },
  });
}

async function markUpdateBestEffort(
  sellerId: number,
  updateId: number,
  status: string
): Promise<void> {
  try {
    await markUpdate(sellerId, updateId, status);
  } catch {
    // Best effort only: the webhook response must not depend on it.
  }
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

  /*
   * Claim the update durably. The unique index on
   * (sellerId, updateId) makes concurrent duplicate deliveries
   * collide here instead of double-processing.
   */
  try {
    const action = await (async () => {
      try {
        await prisma.telegramWebhookUpdate.create({
          data: { sellerId, updateId, status: "PROCESSING" },
        });

        return "process_new" as const;
      } catch (err) {
        if (!isUniqueConstraintViolation(err)) {
          throw err;
        }

        const existing =
          await prisma.telegramWebhookUpdate.findUnique({
            where: {
              sellerId_updateId: { sellerId, updateId },
            },
          });

        return decideClaimAction(existing);
      }
    })();

    if (action === "duplicate" || action === "in_flight") {
      return res.sendStatus(200);
    }

    if (action === "reclaim") {
      await prisma.telegramWebhookUpdate.update({
        where: {
          sellerId_updateId: { sellerId, updateId },
        },
        data: { status: "PROCESSING", updatedAt: new Date() },
      });
    }

    if (isBotMessage(update)) {
      // Bot messages are ignored, but still acknowledged idempotently.
      await markUpdate(sellerId, updateId, "PROCESSED");

      return res.sendStatus(200);
    }

    if (update.kind === "unsupported") {
      await markUpdate(sellerId, updateId, "PROCESSED");

      logger.info(
        "Telegram webhook: acknowledged unsupported update",
        { sellerId, updateType: update.updateType, updateId }
      );

      return res.sendStatus(200);
    }

    const message = update.message;

    if (!message) {
      await markUpdate(sellerId, updateId, "PROCESSED");

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

    const claimWhere = {
      sellerId_updateId: { sellerId, updateId },
    };

    if (update.kind === "edited_message") {
      // Edits update the existing message; no new message record.
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

        await tx.telegramWebhookUpdate.update({
          where: claimWhere,
          data: { status: "PROCESSED" },
        });
      });

      return res.sendStatus(200);
    }

    /*
     * New inbound message. Conversation, message, conversation
     * counters, and the PROCESSED marker commit atomically, so a
     * partial attempt can never appear complete.
     */
    const result = await prisma.$transaction(async (tx) => {
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
          lastMessageAt: new Date(),
        },
        update: {},
      });

      const newMessage = await tx.message.create({
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
            telegramUpdateType: update.updateType,
          },
        },
      });

      const updatedConversation = await tx.conversation.update({
        where: { id: conversation.id },
        data: {
          lastMessage: message.text,
          lastMessageAt: new Date(),
          unreadCount: { increment: 1 },
        },
      });

      await tx.telegramWebhookUpdate.update({
        where: claimWhere,
        data: { status: "PROCESSED" },
      });

      return { newMessage, updatedConversation };
    });

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
    if (isUniqueConstraintViolation(err)) {
      /*
       * The message unique index (conversationId, externalMessageId)
       * already persisted this delivery; treat as an idempotent duplicate.
       */
      await markUpdateBestEffort(sellerId, updateId, "PROCESSED");

      return res.sendStatus(200);
    }

    logger.error(
      "Telegram incoming webhook processing failed:",
      err
    );

    // Failed updates stay retryable: mark FAILED and let Telegram retry.
    await markUpdateBestEffort(sellerId, updateId, "FAILED");

    return res.sendStatus(500);
  }
};
