import { Prisma } from "@prisma/client";
import prisma from "../prisma/client";
import { logger } from "../utils/logger";
import { decrypt } from "./crypto.service";
import {
  getWhatsAppBusinessAccount,
  getPhoneNumbers,
} from "./messaging/whatsapp.service";
import {
  acquirePhoneNumberLock,
  extractPhoneNumberIds,
} from "./whatsappOwnership.service";

/*
 * Safe WhatsApp connection-ownership transfer between sellers.
 *
 * Two phases:
 *   - dryRunTransfer: strictly READ-ONLY report (sellers, phone
 *     numbers, counts, conflicts, assignments, connection
 *     states). No writes of any kind.
 *   - applyTransfer: requires an explicit confirm flag, performs
 *     a live server-side validation of the destination OAuth
 *     connection, then transfers everything inside ONE database
 *     transaction guarded by the per-phone-number advisory
 *     locks the webhook path also acquires (no webhook/transfer
 *     race). Every dry-run check is re-run inside the
 *     transaction; any conflict or source-user assignment aborts
 *     the whole operation with zero writes.
 *
 * The Meta WABA webhook subscription is NEVER unsubscribed here:
 * the WABA may be shared with the destination connection.
 *
 * All writes are journaled to WhatsAppTransferJournal with full
 * before/after state (identifiers only — no tokens, no message
 * contents) so an operator can review and roll back manually.
 */

export type TransferAbortCode =
  | "CONFIRMATION_REQUIRED"
  | "SELLERS_NOT_FOUND"
  | "SAME_SELLER"
  | "SOURCE_CONNECTION_MISSING"
  | "SOURCE_CONNECTION_INACTIVE"
  | "NO_PHONE_NUMBERS"
  | "DESTINATION_CONNECTION_MISSING"
  | "DESTINATION_OAUTH_INVALID"
  | "DESTINATION_PHONE_NUMBERS_MISSING"
  | "OWNERSHIP_MAPPING_INVALID"
  | "DESTINATION_CONVERSATION_CONFLICT"
  | "SOURCE_USER_ASSIGNMENT"
  | "ALREADY_COMPLETED";

export class TransferAbortError extends Error {
  constructor(
    public readonly code: TransferAbortCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "TransferAbortError";
  }
}

type Tx = Prisma.TransactionClient | typeof prisma;

export type TransferConversationSummary = {
  conversationId: number;
  externalUserId: string;
  externalThreadId: string | null;
  customerId: number | null;
  messageCount: number;
  assignedToId: number | null;
};

export type TransferReport = {
  sourceSellerId: number;
  destinationSellerId: number;
  sourceSellerExists: boolean;
  destinationSellerExists: boolean;

  sourceConnection: {
    id: number;
    isActive: boolean;
    wabaId: string | null;
    connectionStatus: string | null;
  } | null;

  destinationConnection: {
    id: number;
    isActive: boolean;
    wabaId: string | null;
    connectionStatus: string | null;
    hasStoredToken: boolean;
  } | null;

  phoneNumberIds: string[];
  wabaId: string | null;

  ownership: Array<{
    phoneNumberId: string;
    activeOwnerConnectionId: number | null;
    activeOwnerSellerId: number | null;
    ambiguous: boolean;
  }>;

  conversationCount: number;
  messageCount: number;
  distinctCustomerCount: number;

  destinationConflicts: Array<{
    externalUserId: string;
    externalThreadId: string | null;
    existingDestinationConversationId: number;
  }>;

  sourceUserAssignments: Array<{
    conversationId: number;
    assignedToId: number;
    assignedToUserSellerId: number | null;
  }>;

  conversations: TransferConversationSummary[];
};

const readConnectionStatus = (metadata: unknown): string | null => {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  const value = (metadata as Record<string, unknown>)
    .connectionStatus;

  return typeof value === "string" ? value : null;
};

const readWabaId = (
  externalAccountId: string | null,
  metadata: unknown
): string | null => {
  if (externalAccountId) {
    return externalAccountId;
  }

  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  const value = (metadata as Record<string, unknown>)
    .whatsappBusinessId;

  return typeof value === "string" ? value : null;
};

/*
 * Shared read-only analysis used by both the dry run and the
 * in-transaction re-check inside apply. NEVER writes.
 */
const buildTransferReport = async (
  db: Tx,
  sourceSellerId: number,
  destinationSellerId: number
): Promise<TransferReport> => {
  const [sourceSeller, destinationSeller] = await Promise.all([
    db.seller.findFirst({
      where: { id: sourceSellerId },
      select: { id: true },
    }),
    db.seller.findFirst({
      where: { id: destinationSellerId },
      select: { id: true },
    }),
  ]);

  const sourceConnection = await db.channelConnection.findFirst({
    where: {
      sellerId: sourceSellerId,
      platform: "WHATSAPP",
    },
    select: {
      id: true,
      isActive: true,
      externalAccountId: true,
      metadata: true,
    },
    orderBy: { id: "asc" },
  });

  const destinationConnection = await db.channelConnection.findFirst({
    where: {
      sellerId: destinationSellerId,
      platform: "WHATSAPP",
    },
    select: {
      id: true,
      isActive: true,
      externalAccountId: true,
      metadata: true,
      accessToken: true,
    },
    orderBy: { id: "asc" },
  });

  const phoneNumberIds = sourceConnection
    ? extractPhoneNumberIds(sourceConnection.metadata)
    : [];

  const wabaId = sourceConnection
    ? readWabaId(
        sourceConnection.externalAccountId,
        sourceConnection.metadata
      )
    : null;

  /*
   * Ownership mapping state for every transferred phone number:
   * the active owner (if any) and whether the mapping is
   * ambiguous (more than one active row — should be impossible
   * under the partial unique index).
   */
  const ownershipRows = phoneNumberIds.length
    ? await db.whatsAppPhoneOwnership.findMany({
        where: {
          phoneNumberId: { in: phoneNumberIds },
          isActive: true,
        },
        select: {
          phoneNumberId: true,
          connectionId: true,
          sellerId: true,
        },
      })
    : [];

  const ownership = phoneNumberIds.map((phoneNumberId) => {
    const rows = ownershipRows.filter(
      (row) => row.phoneNumberId === phoneNumberId
    );

    return {
      phoneNumberId,
      activeOwnerConnectionId: rows[0]?.connectionId ?? null,
      activeOwnerSellerId: rows[0]?.sellerId ?? null,
      ambiguous: rows.length > 1,
    };
  });

  const conversations = phoneNumberIds.length
    ? await db.conversation.findMany({
        where: {
          sellerId: sourceSellerId,
          platform: "WHATSAPP",
          externalThreadId: { in: phoneNumberIds },
        },
        select: {
          id: true,
          customerId: true,
          externalUserId: true,
          externalThreadId: true,
          assignedToId: true,
          _count: { select: { messages: true } },
        },
        orderBy: { id: "asc" },
      })
    : [];

  const messageCount = conversations.reduce(
    (total, conversation) =>
      total + conversation._count.messages,
    0
  );

  const distinctCustomerIds = new Set(
    conversations
      .map((conversation) => conversation.customerId)
      .filter((id): id is number => id !== null)
  );

  /*
   * Destination identity conflicts: the destination seller must
   * not already own a WHATSAPP conversation with the same
   * (externalUserId, externalThreadId) as one being transferred.
   * Any conflict aborts the apply BEFORE writes.
   */
  const destinationConflicts: TransferReport["destinationConflicts"] =
    [];

  for (const conversation of conversations) {
    const clash = await db.conversation.findFirst({
      where: {
        sellerId: destinationSellerId,
        platform: "WHATSAPP",
        externalUserId: conversation.externalUserId,
        externalThreadId: conversation.externalThreadId,
      },
      select: { id: true },
    });

    if (clash) {
      destinationConflicts.push({
        externalUserId: conversation.externalUserId,
        externalThreadId: conversation.externalThreadId,
        existingDestinationConversationId: clash.id,
      });
    }
  }

  /*
   * Source-user assignments: a conversation assigned to a user of
   * the source seller cannot move without an approved
   * reassignment policy. Any such assignment aborts the apply.
   */
  const sourceUserAssignments: TransferReport["sourceUserAssignments"] =
    [];

  for (const conversation of conversations) {
    if (conversation.assignedToId === null) {
      continue;
    }

    const assignee = await db.user.findFirst({
      where: { id: conversation.assignedToId },
      select: { id: true, sellerId: true },
    });

    if (assignee && assignee.sellerId === sourceSellerId) {
      sourceUserAssignments.push({
        conversationId: conversation.id,
        assignedToId: assignee.id,
        assignedToUserSellerId: assignee.sellerId,
      });
    }
  }

  return {
    sourceSellerId,
    destinationSellerId,
    sourceSellerExists: !!sourceSeller,
    destinationSellerExists: !!destinationSeller,

    sourceConnection: sourceConnection
      ? {
          id: sourceConnection.id,
          isActive: sourceConnection.isActive,
          wabaId,
          connectionStatus: readConnectionStatus(
            sourceConnection.metadata
          ),
        }
      : null,

    destinationConnection: destinationConnection
      ? {
          id: destinationConnection.id,
          isActive: destinationConnection.isActive,
          wabaId: readWabaId(
            destinationConnection.externalAccountId,
            destinationConnection.metadata
          ),
          connectionStatus: readConnectionStatus(
            destinationConnection.metadata
          ),
          hasStoredToken: !!destinationConnection.accessToken,
        }
      : null,

    phoneNumberIds,
    wabaId,
    ownership,

    conversationCount: conversations.length,
    messageCount,
    distinctCustomerCount: distinctCustomerIds.size,

    destinationConflicts,
    sourceUserAssignments,

    conversations: conversations.map((conversation) => ({
      conversationId: conversation.id,
      externalUserId: conversation.externalUserId,
      externalThreadId: conversation.externalThreadId,
      customerId: conversation.customerId,
      messageCount: conversation._count.messages,
      assignedToId: conversation.assignedToId,
    })),
  };
};

/*
 * READ-ONLY dry run. Persists a DRY_RUN_REPORTED journal row
 * (journal writes only — no business data is touched) so
 * operations keep an audit trail of what was reviewed.
 */
export const dryRunTransfer = async (input: {
  sourceSellerId: number;
  destinationSellerId: number;
  actorAdminId?: number;
}): Promise<TransferReport> => {
  const report = await buildTransferReport(
    prisma,
    input.sourceSellerId,
    input.destinationSellerId
  );

  try {
    await prisma.whatsAppTransferJournal.create({
      data: {
        sourceSellerId: input.sourceSellerId,
        destinationSellerId: input.destinationSellerId,
        phoneNumberIds: report.phoneNumberIds,
        wabaId: report.wabaId,
        status: "DRY_RUN_REPORTED",
        actorAdminId: input.actorAdminId ?? null,
        report: report as unknown as Prisma.InputJsonValue,
        conversationCount: report.conversationCount,
        messageCount: report.messageCount,
        completedAt: new Date(),
      },
    });
  } catch (err) {
    // Journaling must never break the read-only dry run.
    logger.error(
      "WhatsApp transfer dry-run journaling failed",
      err
    );
  }

  return report;
};

/*
 * Live, server-side validation of the destination OAuth
 * connection. Runs BEFORE any business writes: decrypts the
 * stored token (never returned or logged), fetches the WABA and
 * its phone numbers from Meta, and confirms every transferred
 * phone-number ID is present. Any failure aborts the transfer.
 */
const validateDestinationConnectionLive = async (
  destinationConnection: NonNullable<
    TransferReport["destinationConnection"]
  >,
  phoneNumberIds: string[]
): Promise<void> => {
  const connection = await prisma.channelConnection.findFirst({
    where: {
      id: destinationConnection.id,
      platform: "WHATSAPP",
    },
    select: {
      accessToken: true,
      externalAccountId: true,
      metadata: true,
    },
  });

  if (!connection?.accessToken) {
    throw new TransferAbortError(
      "DESTINATION_OAUTH_INVALID",
      "Destination seller has no stored WhatsApp OAuth token"
    );
  }

  const wabaId = readWabaId(
    connection.externalAccountId,
    connection.metadata
  );

  if (!wabaId) {
    throw new TransferAbortError(
      "DESTINATION_OAUTH_INVALID",
      "Destination WhatsApp connection has no WABA id"
    );
  }

  let accessToken: string;

  try {
    accessToken = decrypt(connection.accessToken);
  } catch {
    throw new TransferAbortError(
      "DESTINATION_OAUTH_INVALID",
      "Destination WhatsApp token could not be decrypted"
    );
  }

  try {
    await getWhatsAppBusinessAccount(accessToken, wabaId);

    const phoneNumbers = await getPhoneNumbers(
      wabaId,
      accessToken
    );

    const available = new Set(
      (Array.isArray(phoneNumbers) ? phoneNumbers : [])
        .map((phone) =>
          phone && typeof phone === "object"
            ? String(
                (phone as Record<string, unknown>).id ?? ""
              )
            : ""
        )
        .filter(Boolean)
    );

    const missing = phoneNumberIds.filter(
      (id) => !available.has(id)
    );

    if (missing.length) {
      throw new TransferAbortError(
        "DESTINATION_PHONE_NUMBERS_MISSING",
        "Destination OAuth connection does not include all transferred phone numbers",
        { missingPhoneNumberIds: missing }
      );
    }
  } catch (error) {
    if (error instanceof TransferAbortError) {
      throw error;
    }

    throw new TransferAbortError(
      "DESTINATION_OAUTH_INVALID",
      "Destination WhatsApp connection could not be validated against Meta",
      error instanceof Error ? error.message : undefined
    );
  }
};

/*
 * Post-commit realtime revocation: evict every socket that is
 * not the destination seller's from the transferred
 * conversation rooms, so stale old-seller room membership can
 * no longer receive new_message / message_status_updated /
 * conversation_updated events.
 */
export const evictSocketsFromConversations = async (
  io: any,
  conversationIds: number[],
  destinationSellerId: number
): Promise<number> => {
  if (!io || !conversationIds.length) {
    return 0;
  }

  let evicted = 0;

  for (const conversationId of conversationIds) {
    try {
      const sockets = await io
        .in(`room_${conversationId}`)
        .fetchSockets();

      for (const socket of sockets) {
        if (
          (socket.data?.sellerId as number | undefined) !==
          destinationSellerId
        ) {
          socket.emit("conversation_access_revoked", {
            conversationId,
          });

          socket.leave(`room_${conversationId}`);

          evicted += 1;
        }
      }
    } catch (err) {
      logger.error(
        "WhatsApp transfer socket eviction failed",
        err
      );
    }
  }

  return evicted;
};

export type ApplyTransferResult = {
  status: "COMPLETED" | "ALREADY_COMPLETED";
  journalId: string;
  report: TransferReport;
  conversationCount: number;
  messageCount: number;
  evictedSockets: number;
};

export const applyTransfer = async (input: {
  sourceSellerId: number;
  destinationSellerId: number;
  confirm: boolean;
  actorAdminId?: number;
  io?: unknown;
}): Promise<ApplyTransferResult> => {
  if (input.confirm !== true) {
    throw new TransferAbortError(
      "CONFIRMATION_REQUIRED",
      "Pass confirm: true to apply a WhatsApp ownership transfer"
    );
  }

  const { sourceSellerId, destinationSellerId } = input;

  if (sourceSellerId === destinationSellerId) {
    throw new TransferAbortError(
      "SAME_SELLER",
      "Source and destination sellers must differ"
    );
  }

  /*
   * Idempotent retry: a COMPLETED journal row for the same
   * seller pair whose phone-number set covers the current claim
   * means the transfer already happened — report instead of
   * duplicating work.
   */
  const completed = await prisma.whatsAppTransferJournal.findFirst({
    where: {
      sourceSellerId,
      destinationSellerId,
      status: "COMPLETED",
    },
    orderBy: { createdAt: "desc" },
  });

  const preReport = await buildTransferReport(
    prisma,
    sourceSellerId,
    destinationSellerId
  );

  if (
    completed &&
    preReport.phoneNumberIds.every((id) =>
      ((completed.phoneNumberIds as unknown) as string[]).includes(
        id
      )
    )
  ) {
    return {
      status: "ALREADY_COMPLETED",
      journalId: completed.id,
      report: preReport,
      conversationCount: 0,
      messageCount: 0,
      evictedSockets: 0,
    };
  }

  // ---- Static preconditions (fail before any writes) ----

  if (!preReport.sourceSellerExists || !preReport.destinationSellerExists) {
    throw new TransferAbortError(
      "SELLERS_NOT_FOUND",
      "Source or destination seller does not exist"
    );
  }

  if (!preReport.sourceConnection) {
    throw new TransferAbortError(
      "SOURCE_CONNECTION_MISSING",
      "Source seller has no WhatsApp connection"
    );
  }

  if (!preReport.sourceConnection.isActive) {
    throw new TransferAbortError(
      "SOURCE_CONNECTION_INACTIVE",
      "Source seller WhatsApp connection is not active"
    );
  }

  if (!preReport.phoneNumberIds.length) {
    throw new TransferAbortError(
      "NO_PHONE_NUMBERS",
      "Source connection claims no phone numbers"
    );
  }

  if (!preReport.destinationConnection) {
    throw new TransferAbortError(
      "DESTINATION_CONNECTION_MISSING",
      "Destination seller has no WhatsApp connection"
    );
  }

  if (
    preReport.ownership.some(
      (entry) =>
        entry.activeOwnerConnectionId === null || entry.ambiguous
    )
  ) {
    throw new TransferAbortError(
      "OWNERSHIP_MAPPING_INVALID",
      "Ownership mapping is incomplete or ambiguous for the transferred numbers",
      preReport.ownership
    );
  }

  // ---- Live destination OAuth validation (fail before writes) ----

  await validateDestinationConnectionLive(
    preReport.destinationConnection,
    preReport.phoneNumberIds
  );

  /*
   * ---- The transfer transaction ----
   *
   * All locks are acquired up front in sorted order, then every
   * check is re-run INSIDE the transaction. Any failure throws
   * and rolls back the entire operation with zero writes.
   */
  const sortedPhoneIds = [...preReport.phoneNumberIds].sort();

  const result = await prisma.$transaction(
    async (tx) => {
      for (const phoneNumberId of sortedPhoneIds) {
        await acquirePhoneNumberLock(tx, phoneNumberId);
      }

      const report = await buildTransferReport(
        tx,
        sourceSellerId,
        destinationSellerId
      );

      if (report.destinationConflicts.length) {
        throw new TransferAbortError(
          "DESTINATION_CONVERSATION_CONFLICT",
          "Destination seller already owns a conversation with the same WhatsApp identity; aborting without writes",
          report.destinationConflicts
        );
      }

      if (report.sourceUserAssignments.length) {
        throw new TransferAbortError(
          "SOURCE_USER_ASSIGNMENT",
          "Conversations assigned to source-seller users cannot be transferred without an approved reassignment policy",
          report.sourceUserAssignments
        );
      }

      const destinationConnectionId =
        report.destinationConnection?.id;

      if (!destinationConnectionId) {
        throw new TransferAbortError(
          "DESTINATION_CONNECTION_MISSING",
          "Destination WhatsApp connection disappeared"
        );
      }

      const details: Array<{
        conversationId: number;
        prevSellerId: number;
        prevCustomerId: number | null;
        newCustomerId: number | null;
        prevAssignedToId: number | null;
      }> = [];

      for (const summary of report.conversations) {
        /*
         * Map to a DESTINATION-owned Customer: find-or-create by
         * phone. The source seller's Customer rows and their
         * orders are never modified or moved.
         */
        const conversation = await tx.conversation.findUnique({
          where: { id: summary.conversationId },
          select: {
            id: true,
            customerId: true,
            customerName: true,
            customerPhone: true,
            customerEmail: true,
            assignedToId: true,
          },
        });

        if (!conversation) {
          continue;
        }

        let newCustomerId: number | null = null;

        if (conversation.customerPhone) {
          const existing =
            await tx.customer.findFirst({
              where: {
                sellerId: destinationSellerId,
                phone: conversation.customerPhone,
              },
              select: { id: true },
            });

          if (existing) {
            newCustomerId = existing.id;
          } else {
            const created = await tx.customer.create({
              data: {
                sellerId: destinationSellerId,
                name: conversation.customerName,
                phone: conversation.customerPhone,
                email: conversation.customerEmail ?? null,
              },
            });

            newCustomerId = created.id;
          }
        }

        // Move the conversation IN PLACE — id and messages retained.
        await tx.conversation.update({
          where: { id: conversation.id },
          data: {
            sellerId: destinationSellerId,
            customerId: newCustomerId,
          },
        });

        details.push({
          conversationId: conversation.id,
          prevSellerId: sourceSellerId,
          prevCustomerId: conversation.customerId,
          newCustomerId,
          prevAssignedToId: conversation.assignedToId,
        });
      }

      /*
       * Flip ownership rows: deactivate any active row for the
       * transferred numbers (the source connection's), then point
       * them at the destination connection. The partial unique
       * index is the hard backstop against duplicate actives.
       */
      for (const phoneNumberId of sortedPhoneIds) {
        await tx.whatsAppPhoneOwnership.updateMany({
          where: {
            phoneNumberId,
            isActive: true,
          },
          data: { isActive: false },
        });

        await tx.whatsAppPhoneOwnership.create({
          data: {
            phoneNumberId,
            connectionId: destinationConnectionId,
            sellerId: destinationSellerId,
            wabaId: report.wabaId,
            isActive: true,
          },
        });
      }

      /*
       * Disable the SOURCE connection locally. NEVER call
       * unsubscribeWabaWebhooks here — the WABA subscription is
       * app-level and still needed by the destination.
       */
      const sourceConnectionCurrent =
        await tx.channelConnection.findUnique({
          where: { id: report.sourceConnection.id },
          select: { metadata: true },
        });

      await tx.channelConnection.update({
        where: { id: report.sourceConnection.id },
        data: {
          isActive: false,
          metadata: {
            ...((sourceConnectionCurrent?.metadata ??
              {}) as Prisma.InputJsonObject),
            connectionStatus: "TRANSFERRED",
            transferredToSellerId: destinationSellerId,
            transferredAt: new Date().toISOString(),
          } as Prisma.InputJsonObject,
        },
      });

      const journal = await tx.whatsAppTransferJournal.create({
        data: {
          sourceSellerId,
          destinationSellerId,
          phoneNumberIds: sortedPhoneIds,
          wabaId: report.wabaId,
          status: "COMPLETED",
          actorAdminId: input.actorAdminId ?? null,
          report: report as unknown as Prisma.InputJsonValue,
          details: details as unknown as Prisma.InputJsonValue,
          conversationCount: report.conversationCount,
          messageCount: report.messageCount,
          connectionStates: {
            sourceConnectionBefore: {
              id: report.sourceConnection?.id ?? null,
              isActive: true,
              connectionStatus:
                report.sourceConnection?.connectionStatus ?? null,
            },
            sourceConnectionAfter: {
              id: report.sourceConnection?.id ?? null,
              isActive: false,
              connectionStatus: "TRANSFERRED",
              transferredToSellerId: destinationSellerId,
            },
            destinationConnectionId,
          } as Prisma.InputJsonObject,
          completedAt: new Date(),
        },
      });

      return {
        journalId: journal.id,
        report,
        conversationIds: report.conversations.map(
          (conversation) => conversation.conversationId
        ),
      };
    },
    {
      isolationLevel:
        Prisma.TransactionIsolationLevel.Serializable,
    }
  );

  // ---- Post-commit realtime revocation ----

  const evictedSockets = await evictSocketsFromConversations(
    input.io,
    result.conversationIds,
    destinationSellerId
  );

  return {
    status: "COMPLETED",
    journalId: result.journalId,
    report: result.report,
    conversationCount: result.report.conversationCount,
    messageCount: result.report.messageCount,
    evictedSockets,
  };
};
