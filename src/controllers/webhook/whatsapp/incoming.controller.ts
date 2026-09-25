import { Request, Response } from "express";
import prisma from "../../../prisma/client";
import { Prisma } from "@prisma/client";
import { logger } from "../../../utils/logger";
import {
  processWhatsAppStatuses,
  StatusUpdateResult,
} from "./status.controller";

type WhatsAppMetadata = {
  phoneNumberIds?: unknown;
  phoneNumbers?: unknown;
};

const findSellerConnection = async (phoneNumberId: string) => {
  const connections = await prisma.channelConnection.findMany({
    where: {
      platform: "WHATSAPP",
      isActive: true,
    },
    select: {
      id: true,
      sellerId: true,
      metadata: true,
    },
  });

  return connections.find((connection) => {
    const metadata = (connection.metadata ?? {}) as WhatsAppMetadata;

    if (Array.isArray(metadata.phoneNumberIds)) {
      if (
        metadata.phoneNumberIds.some(
          (id) => String(id) === phoneNumberId
        )
      ) {
        return true;
      }
    }

    if (Array.isArray(metadata.phoneNumbers)) {
      return metadata.phoneNumbers.some((phone) => {
        if (!phone || typeof phone !== "object") {
          return false;
        }

        const value = phone as Record<string, unknown>;

        return (
          String(
            value.id ?? value.phone_number_id ?? ""
          ) === phoneNumberId
        );
      });
    }

    return false;
  });
};

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

  const connection = await findSellerConnection(
    phoneNumberId
  );

  if (!connection) {
    // Do not reveal or log channel/account details.
    return null;
  }

  const sellerId = connection.sellerId;
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

  try {
    const result = await prisma.$transaction(
      async (tx) => {
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
    // If a unique constraint is added for webhook idempotency,
    // concurrent delivery of the same Meta message can safely
    // be treated as already processed.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const conversation =
        await prisma.conversation.findFirst({
          where: {
            sellerId,
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

        io.to(
          `room_${item.conversation.id}`
        ).emit(
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

        io.to(
          `room_${item.conversation.id}`
        ).emit("message_status_updated", {
          conversationId: item.conversation.id,
          messageId: item.message.id,
          status: item.message.status,
        });
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
