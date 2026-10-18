import { Request, Response } from "express";
import prisma from "../../../prisma/client";
import { Prisma } from "@prisma/client";
import { logger } from "../../../utils/logger";
import {
  processWhatsAppStatuses,
  StatusUpdateResult,
} from "./status.controller";
import {
  acquirePhoneNumberLock,
  PhoneOwnershipError,
  resolveActiveOwner,
} from "../../../services/whatsappOwnership.service";
import { emitToConversationRoom } from "../../../services/conversationRealtime.service";

const getCustomerName = (
  contacts: unknown,
  customerPhone: string
): string => {
  if (!Array.isArray(contacts)) {
    return customerPhone;
  }

  const contact = contacts.find((item) => {
    if (!item || typeof item !== "object") {
      return false;
    }

    return (
      String(
        (item as Record<string, unknown>).wa_id ?? ""
      ) === customerPhone
    );
  });

  if (
    contact &&
    typeof contact === "object"
  ) {
    const profile = (contact as Record<string, unknown>)
      .profile;

    if (
      profile &&
      typeof profile === "object" &&
      typeof (profile as Record<string, unknown>).name ===
        "string"
    ) {
      return String(
        (profile as Record<string, unknown>).name
      ).trim() || customerPhone;
    }
  }

  return customerPhone;
};

const processMessage = async (
  value: Record<string, any>,
  message: Record<string, any>
) => {
  const phoneNumberId = String(
    value.metadata?.phone_number_id ?? ""
  ).trim();

  const customerPhone = String(
    message.from ?? ""
  ).trim();

  const externalMessageId = String(
    message.id ?? ""
  ).trim();

  if (
    !phoneNumberId ||
    !customerPhone ||
    !externalMessageId
  ) {
    return null;
  }

  const customerName = getCustomerName(
    value.contacts,
    customerPhone
  );

  const messageType = String(
    message.type ?? "text"
  );

  const text =
    messageType === "text"
      ? String(message.text?.body ?? "").trim()
      : `[WhatsApp ${messageType} message]`;

  if (!text) {
    return null;
  }

  const timestampSeconds = Number(
    message.timestamp
  );

  const createdAt =
    Number.isFinite(timestampSeconds) &&
    timestampSeconds > 0
      ? new Date(timestampSeconds * 1000)
      : new Date();

  const safeMetadata: Record<string, string> = {
    whatsappMessageType: messageType,
    phoneNumberId,
  };

  if (
    Number.isFinite(timestampSeconds) &&
    timestampSeconds > 0
  ) {
    safeMetadata.whatsappTimestamp = String(
      message.timestamp
    );
  }

  // Seller resolved inside the transaction below; kept for the
  // P2002 idempotency recovery path.
  let resolvedSellerId: number | null = null;

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        /*
         * Serialize with ownership changes: the advisory lock is
         * held until commit, covering ownership resolution through
         * the durable persistence of this message. A concurrent
         * ownership transfer waits, or this webhook waits for it.
         */
        await acquirePhoneNumberLock(tx, phoneNumberId);

        /*
         * Authoritative, fail-closed ownership resolution. Never
         * scans connection metadata for a first match: unknown or
         * ambiguous phone numbers throw instead of routing the
         * message to an arbitrary seller.
         */
        const owner = await resolveActiveOwner(
          tx,
          phoneNumberId
        );

        const sellerId = owner.sellerId;
        resolvedSellerId = sellerId;

        let customer = await tx.customer.findFirst({
          where: {
            sellerId,
            phone: customerPhone,
          },
        });

        if (!customer) {
          customer = await tx.customer.create({
            data: {
              sellerId,
              name: customerName,
              phone: customerPhone,
            },
          });
        } else if (
          customer.name !== customerName &&
          customerName !== customerPhone
        ) {
          customer = await tx.customer.update({
            where: { id: customer.id },
            data: { name: customerName },
          });
        }

        const conversation =
          await tx.conversation.upsert({
            where: {
              sellerId_platform_externalUserId_externalThreadId:
                {
                  sellerId,
                  platform: "WHATSAPP",
                  externalUserId: customerPhone,
                  externalThreadId: phoneNumberId,
                },
            },
            create: {
              sellerId,
              platform: "WHATSAPP",
              customerId: customer.id,
              customerName,
              customerPhone,
              externalUserId: customerPhone,
              externalThreadId: phoneNumberId,
              unreadCount: 0,
              lastMessage: text,
              lastMessageAt: createdAt,
            },
            update: {
              customerId: customer.id,
              customerName,
              customerPhone,
            },
          });

        const existing =
          await tx.message.findFirst({
            where: {
              conversationId: conversation.id,
              externalMessageId,
            },
          });

        if (existing) {
          return {
            duplicate: true,
            message: existing,
            conversation,
          };
        }

        const newMessage =
          await tx.message.create({
            data: {
              conversationId: conversation.id,
              sender: "CUSTOMER",
              direction: "INBOUND",
              status: "DELIVERED",
              text,
              type: messageType,
              externalMessageId,
              metadata: safeMetadata,
              isRead: false,
              createdAt,
            },
          });

        const updatedConversation =
          await tx.conversation.update({
            where: {
              id: conversation.id,
            },
            data: {
              lastMessage: text,
              lastMessageAt: createdAt,
              unreadCount: {
                increment: 1,
              },
            },
          });

        return {
          duplicate: false,
          message: newMessage,
          conversation: updatedConversation,
        };
      }
    );

    return result;
  } catch (error) {
    // Fail closed: an unknown/ambiguous phone number or an inactive
    // owning connection must NOT be treated as "processed". Re-throw
    // so receiveMessage returns 500 and Meta retries the webhook.
    if (error instanceof PhoneOwnershipError) {
      logger.warn(
        "WhatsApp inbound routing failed closed:",
        error.code
      );

      throw error;
    }

    // Concurrent delivery of the same Meta message can safely be
    // treated as already processed when the idempotency unique
    // constraint (conversationId, externalMessageId) fired.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002" &&
      resolvedSellerId !== null
    ) {
      const conversation =
        await prisma.conversation.findFirst({
          where: {
            sellerId: resolvedSellerId,
            platform: "WHATSAPP",
            externalUserId: customerPhone,
            externalThreadId: phoneNumberId,
          },
        });

      if (conversation) {
        const existing =
          await prisma.message.findFirst({
            where: {
              conversationId: conversation.id,
              externalMessageId,
            },
          });

        if (existing) {
          return {
            duplicate: true,
            message: existing,
            conversation,
          };
        }
      }
    }

    throw error;
  }
};

export const receiveMessage = async (
  req: Request,
  res: Response
): Promise<Response> => {
  try {
    const body = req.body;

    if (
      !body ||
      typeof body !== "object" ||
      !Array.isArray(body.entry)
    ) {
      return res.sendStatus(200);
    }

    const processed: Array<{
      message: any;
      conversation: any;
    }> = [];

    const statusProcessed: StatusUpdateResult[] = [];

    for (const entry of body.entry) {
      if (
        !entry ||
        typeof entry !== "object" ||
        !Array.isArray(entry.changes)
      ) {
        continue;
      }

      for (const change of entry.changes) {
        const value = change?.value;

        if (
          !value ||
          typeof value !== "object"
        ) {
          continue;
        }

        /*
         * Message status updates (sent / delivered / read /
         * failed) arrive on the same webhook as messages.
         */
        const statusUpdates = Array.isArray(
          value.statuses
        )
          ? await processWhatsAppStatuses(value)
          : [];

        if (Array.isArray(value.messages)) {
          for (const message of value.messages) {
            if (
              !message ||
              typeof message !== "object"
            ) {
              continue;
            }

            const result = await processMessage(
              value,
              message
            );

            if (
              result &&
              !result.duplicate
            ) {
              processed.push(result);
            }
          }
        }

        statusProcessed.push(...statusUpdates);
      }
    }

    const io = req.app.get("io");

    if (io) {
      for (const item of processed) {
        io.to(
          `seller_${item.conversation.sellerId}`
        ).emit("conversation_updated", {
          conversationId: item.conversation.id,
          conversation: item.conversation,
        });

        /*
         * Tenant-safe room emission: only sockets of the
         * conversation's CURRENT owner receive room events, so
         * stale membership (e.g. after an ownership transfer)
         * cannot expose messages across sellers.
         */
        await emitToConversationRoom(
          io,
          item.conversation.id,
          item.conversation.sellerId,
          "new_message",
          item.message
        );
      }

      for (const item of statusProcessed) {
        io.to(
          `seller_${item.conversation.sellerId}`
        ).emit("message_status_updated", {
          conversationId: item.conversation.id,
          messageId: item.message.id,
          status: item.message.status,
        });

        await emitToConversationRoom(
          io,
          item.conversation.id,
          item.conversation.sellerId,
          "message_status_updated",
          {
            conversationId: item.conversation.id,
            messageId: item.message.id,
            status: item.message.status,
          }
        );
      }
    }

    return res.sendStatus(200);
  } catch (error) {
    logger.error(
      "WhatsApp webhook processing failed:",
      error instanceof Error
        ? error.message
        : "unknown error"
    );

    // A 5xx tells Meta to retry the webhook.
    return res.sendStatus(500);
  }
};
