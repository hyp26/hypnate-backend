import { Request, Response } from "express";
import prisma from "../../../prisma/client";
import { Prisma, MessageStatus } from "@prisma/client";
import { logger } from "../../../utils/logger";
import {
  acquirePhoneNumberLock,
  resolveActiveOwner,
} from "../../../services/whatsappOwnership.service";

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

  /*
   * SECURITY (audit finding H-2): the WhatsApp phone identity
   * must come from the webhook payload itself. Without a
   * reliable phone-number ID there is no lock key and no
   * authoritative owner to scope the lookup to — fail closed
   * BEFORE any database access. No global message search, no
   * fallback to a pre-lock conversation thread lookup, and no
   * unlocked update path exist anymore.
   */
  const phoneNumberId = String(
    value?.metadata?.phone_number_id ?? ""
  ).trim();

  if (!phoneNumberId) {
    return null;
  }

  /*
   * SECURITY (audit finding H-2): identity resolution, lock
   * acquisition, message lookup, validation and the status
   * write all happen inside ONE transaction, serialized with
   * ownership transfers through the SAME per-phone advisory
   * lock the inbound webhook and the transfer workflow use.
   *
   * Order of operations inside the transaction:
   *   1. Acquire the phone-number advisory lock (first DB op).
   *   2. Resolve the authoritative ACTIVE owner under the lock.
   *   3. Look up the message scoped to that owner.
   *   4. Validate message/conversation/phone/owner relationship.
   *   5. Delivery-progress ordering checks on the FRESH message.
   *   6. Merge status metadata and update — still in this tx.
   *
   * A concurrent transfer therefore either completes before
   * step 2 (the lookup is scoped to the NEW owner) or waits
   * until this transaction commits. PhoneOwnershipError thrown
   * by step 2 (unknown/ambiguous/inactive ownership) aborts the
   * transaction with no write — fail closed.
   */
  return prisma.$transaction(async (tx) => {
    await acquirePhoneNumberLock(tx, phoneNumberId);

    const owner = await resolveActiveOwner(
      tx,
      phoneNumberId
    );

    /*
     * Tenant-scoped lookup. externalMessageId is NOT globally
     * unique — the schema enforces uniqueness only per
     * (conversationId, externalMessageId) — so the lookup is
     * constrained to the resolved owner's tenant, an OUTBOUND
     * message, a WHATSAPP conversation whose thread IS this
     * phone number. `take: 2` makes ambiguity detectable:
     * anything other than exactly one match fails closed.
     */
    const matches = await tx.message.findMany({
      where: {
        externalMessageId,
        direction: "OUTBOUND",
        conversation: {
          platform: "WHATSAPP",
          externalThreadId: phoneNumberId,
          sellerId: owner.sellerId,
        },
      },
      include: {
        conversation: {
          select: {
            id: true,
            sellerId: true,
            platform: true,
            externalThreadId: true,
          },
        },
      },
      take: 2,
    });

    if (matches.length !== 1) {
      /*
       * No scoped match, or an ambiguous match: no message is
       * modified. Never widen the search to recover a match.
       */
      return null;
    }

    const message = matches[0];

    const conversation = message.conversation;

    /*
     * Explicit validation of the full relationship between
     * message, conversation, phone identity and the active
     * owner — defense in depth on top of the scoped query.
     */
    if (conversation.sellerId !== owner.sellerId) {
      return null;
    }

    if (conversation.platform !== "WHATSAPP") {
      return null;
    }

    if (conversation.externalThreadId !== phoneNumberId) {
      return null;
    }

    /*
     * Never downgrade delivery state (delivered -> sent) or
     * replay the same state. Failed is always applied because
     * it is terminal. Evaluated against the FRESH in-transaction
     * message row — never a pre-lock snapshot.
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

    /*
     * Merge into the FRESH message's current metadata (read
     * under the lock in this transaction), not a pre-lock
     * snapshot — concurrent status events cannot clobber each
     * other's fields.
     */
    const baseMetadata = (message.metadata ??
      {}) as Prisma.JsonObject;

    const updated = await tx.message.update({
      where: { id: message.id },
      data: {
        status: mappedStatus,
        metadata: {
          ...baseMetadata,
          ...safeMetadata,
        },
      },
    });

    /*
     * Identifiers come from the validated in-transaction state:
     * the caller (H-1 emit-time authorization) never receives a
     * sellerId captured before a concurrent ownership transfer.
     */
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
  });
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
      /*
       * Includes PhoneOwnershipError (unknown/ambiguous/inactive
       * ownership): the transaction rolled back, no message was
       * modified, and remaining statuses still get processed.
       */
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
