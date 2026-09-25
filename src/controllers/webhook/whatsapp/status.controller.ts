import { Request, Response } from "express";
import prisma from "../../../prisma/client";
import { Prisma, MessageStatus } from "@prisma/client";
import { logger } from "../../../utils/logger";

/*
 * Meta reports outbound message statuses as:
 *
 *   sent -> delivered -> read, or failed.
 *
 * These map directly onto the existing MessageStatus enum
 * (SENT, DELIVERED, READ, FAILED).
 */

const STATUS_VALUES: Record<string, MessageStatus> = {
  sent: "SENT",
  delivered: "DELIVERED",
  read: "READ",
  failed: "FAILED",
};

/*
 * Delivery progress rank. Used to avoid downgrading a message
 * status (for example delivered -> sent) when Meta retries or
 * reorders webhook events.
 */

const STATUS_RANK: Record<string, number> = {
  SENT: 1,
  DELIVERED: 2,
  READ: 3,
};

export type StatusUpdateResult = {
  message: {
    id: number;
    status: MessageStatus;
  };
  conversation: {
    id: number;
    sellerId: number;
  };
};

const processStatus = async (
  value: Record<string, any>,
  status: Record<string, any>
): Promise<StatusUpdateResult | null> => {
  const externalMessageId = String(
    status?.id ?? ""
  ).trim();

  if (!externalMessageId) {
    return null;
  }

  const statusValue = String(
    status?.status ?? ""
  ).toLowerCase();

  const mappedStatus = STATUS_VALUES[statusValue];

  /*
   * Unknown statuses (for example "deleted") are acknowledged
   * without any state change.
   */
  if (!mappedStatus) {
    return null;
  }

  const phoneNumberId = String(
    value?.metadata?.phone_number_id ?? ""
  ).trim();

  const message = await prisma.message.findFirst({
    where: {
      externalMessageId,
      direction: "OUTBOUND",
    },
    include: {
      conversation: {
        select: {
          id: true,
          sellerId: true,
          externalThreadId: true,
        },
      },
    },
  });

  /*
   * Statuses for unknown or inbound messages are ignored.
   */
  if (!message) {
    return null;
  }

  const conversation = message.conversation;

  /*
   * Tenant safety: when Meta provides the originating phone
   * number id, it must match the conversation thread that
   * owns the message.
   */
  if (
    phoneNumberId &&
    conversation.externalThreadId &&
    conversation.externalThreadId !== phoneNumberId
  ) {
    return null;
  }

  /*
   * Never downgrade delivery state (delivered -> sent) or
   * replay the same state. Failed is always applied because it
   * is terminal.
   */
  if (
    mappedStatus !== "FAILED" &&
    STATUS_RANK[message.status] !== undefined &&
    STATUS_RANK[mappedStatus] !== undefined &&
    STATUS_RANK[mappedStatus] <=
      STATUS_RANK[message.status]
  ) {
    return null;
  }

  const safeMetadata: Record<string, string> = {
    whatsappStatus: statusValue,
  };

  const statusTimestampSeconds = Number(
    status?.timestamp
  );

  if (
    Number.isFinite(statusTimestampSeconds) &&
    statusTimestampSeconds > 0
  ) {
    safeMetadata.whatsappStatusTimestamp = String(
      status.timestamp
    );
  }

  const errors = Array.isArray(status?.errors)
    ? status.errors
    : [];

  const firstError = errors.find(
    (error) =>
      !!error && typeof error === "object"
  ) as Record<string, unknown> | undefined;

  if (firstError) {
    if (firstError.code !== undefined) {
      safeMetadata.whatsappErrorCode = String(
        firstError.code
      );
    }

    if (typeof firstError.title === "string") {
      safeMetadata.whatsappErrorTitle =
        firstError.title.slice(0, 200);
    }
  }

  const baseMetadata = (message.metadata ??
    {}) as Prisma.JsonObject;

  const updated = await prisma.message.update({
    where: { id: message.id },
    data: {
      status: mappedStatus,
      metadata: {
        ...baseMetadata,
        ...safeMetadata,
      },
    },
  });

  return {
    message: {
      id: updated.id,
      status: updated.status,
    },
    conversation: {
      id: conversation.id,
      sellerId: conversation.sellerId,
    },
  };
};

/*
 * Process the statuses array of a WhatsApp webhook value
 * payload. Errors for individual statuses are logged but do
 * not abort processing of the remaining statuses.
 */
export const processWhatsAppStatuses = async (
  value: Record<string, any>
): Promise<StatusUpdateResult[]> => {
  const results: StatusUpdateResult[] = [];

  const statuses = value?.statuses;

  if (!Array.isArray(statuses)) {
    return results;
  }

  for (const status of statuses) {
    if (!status || typeof status !== "object") {
      continue;
    }

    try {
      const result = await processStatus(
        value,
        status
      );

      if (result) {
        results.push(result);
      }
    } catch (error) {
      logger.error(
        "WhatsApp status update failed:",
        error instanceof Error
          ? error.message
          : "unknown error"
      );
    }
  }

  return results;
};

/*
 * Standalone status webhook handler.
 *
 * Status events normally arrive on the shared WhatsApp webhook
 * (receiveMessage) and are processed there. This handler simply
 * acknowledges any direct routing of status events.
 */
export const messageStatus = async (
  _req: Request,
  res: Response
): Promise<Response> => {
  try {
    return res.sendStatus(200);
  } catch (error) {
    logger.error(
      "WhatsApp status webhook handling failed:",
      error instanceof Error
        ? error.message
        : "unknown error"
    );

    return res.sendStatus(500);
  }
};
