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
  | "ALREADY_COMPLETED"
  | "DESTINATION_CONNECTION_INACTIVE"
  | "JOURNAL_STATE_INVALID"
  | "CONCURRENT_TRANSFER_CONFLICT"
  | "DESTINATION_CUSTOMER_MAPPING_AMBIGUOUS";

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
 * Runtime validation of a persisted journal payload.
 *
 * Prisma types JSON columns as JsonValue; nothing about a stored
 * journal row is trusted until it is parsed. Accept ONLY an
 * array of non-empty strings (trimmed, deduplicated, sorted).
 * Anything else is malformed and must never yield
 * ALREADY_COMPLETED.
 */
export const parseJournalPhoneIds = (
  value: Prisma.JsonValue
): string[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }

  const ids: string[] = [];

  for (const entry of value) {
    if (typeof entry !== "string") {
      return null;
    }

    const id = entry.trim();

    if (!id) {
      return null;
    }

    if (!ids.includes(id)) {
      ids.push(id);
    }
  }

  return ids.sort();
};

const normalizePhoneIdSet = (ids: string[]): Set<string> => {
  const set = new Set<string>();

  for (const id of ids) {
    const trimmed = id.trim();

    if (trimmed) {
      set.add(trimmed);
    }
  }

  return set;
};

const isNonNegativeInteger = (
  value: unknown
): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0;

/*
 * Recover conversation/message counts for an already-completed
 * transfer from its persisted journal row. Trust the structured
 * integer columns first, then the persisted transfer report.
 * If neither holds a trustworthy non-negative integer pair,
 * return null — the caller must abort and require manual
 * review. Counts are NEVER invented or defaulted to zero.
 */
export const recoverJournalCounts = (journal: {
  report: Prisma.JsonValue;
  conversationCount: number | null;
  messageCount: number | null;
}): {
  conversationCount: number;
  messageCount: number;
} | null => {
  const fromColumns =
    isNonNegativeInteger(journal.messageCount) &&
    isNonNegativeInteger(journal.conversationCount)
      ? {
          conversationCount: journal.conversationCount,
          messageCount: journal.messageCount,
        }
      : null;

  const report = journal.report;

  const record =
    report && typeof report === "object" && !Array.isArray(report)
      ? (report as Record<string, unknown>)
      : null;

  const fromReport =
    record &&
    isNonNegativeInteger(record.messageCount) &&
    isNonNegativeInteger(record.conversationCount)
      ? {
          conversationCount: record.conversationCount,
          messageCount: record.messageCount,
        }
      : null;

  /*
   * Consistency: when BOTH sources hold valid counts they must
   * AGREE. Disagreement means the journal row is internally
   * inconsistent — treat as invalid and require manual review
   * rather than picking a source arbitrarily.
   */
  if (fromColumns && fromReport) {
    if (
      fromColumns.conversationCount !== fromReport.conversationCount ||
      fromColumns.messageCount !== fromReport.messageCount
    ) {
      return null;
    }

    return fromColumns;
  }

  return fromColumns ?? fromReport;
};

/*
 * WABA agreement check for ALREADY_COMPLETED: the persisted
 * journal's WABA id must be a non-empty string AND must match
 * both the CURRENT source connection's WABA and the CURRENT
 * destination connection's WABA. Any mismatch means the
 * connection landscape changed since the recorded transfer —
 * do NOT short-circuit; fall through to a full apply.
 */
export const wabaIdsAgree = (
  journalWabaId: string | null,
  currentSourceWabaId: string | null,
  currentDestinationWabaId: string | null
): boolean => {
  if (
    typeof journalWabaId !== "string" ||
    !journalWabaId.trim() ||
    typeof currentSourceWabaId !== "string" ||
    !currentSourceWabaId.trim() ||
    typeof currentDestinationWabaId !== "string" ||
    !currentDestinationWabaId.trim()
  ) {
    return false;
  }

  return (
    journalWabaId === currentSourceWabaId &&
    journalWabaId === currentDestinationWabaId
  );
};

/*
 * Validate conversation IDs before socket eviction: every id
 * must be a unique positive safe integer, and their count must
 * match the valid recorded conversation count. Returns the
 * validated ids, or null when the state is untrustworthy (the
 * caller must abort for manual review — never evict arbitrary
 * rooms from unvalidated data).
 */
export const validateEvictionConversationIds = (
  ids: unknown,
  expectedConversationCount: number
): number[] | null => {
  if (!Array.isArray(ids)) {
    return null;
  }

  if (
    !isNonNegativeInteger(expectedConversationCount) ||
    ids.length !== expectedConversationCount
  ) {
    return null;
  }

  const seen = new Set<number>();
  const validated: number[] = [];

  for (const id of ids) {
    if (
      typeof id !== "number" ||
      !Number.isInteger(id) ||
      id <= 0 ||
      id > Number.MAX_SAFE_INTEGER
    ) {
      return null;
    }

    if (seen.has(id)) {
      return null;
    }

    seen.add(id);
    validated.push(id);
  }

  return validated;
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
export type DryRunTransferResult = TransferReport & {
  /*
   * Whether the DRY_RUN_REPORTED audit-journal row was actually
   * persisted. Journaling failure never breaks the read-only
   * report, but it is NEVER silently claimed as recorded — the
   * caller (admin API response) sees the real outcome.
   */
  auditRecorded: boolean;
};

export const dryRunTransfer = async (input: {
  sourceSellerId: number;
  destinationSellerId: number;
  actorAdminId?: number;
}): Promise<DryRunTransferResult> => {
  const report = await buildTransferReport(
    prisma,
    input.sourceSellerId,
    input.destinationSellerId
  );

  let auditRecorded = false;

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

    auditRecorded = true;
  } catch (err) {
    // Journaling must never break the read-only dry run — but
    // the failure is exposed to the caller via auditRecorded.
    logger.error(
      "WhatsApp transfer dry-run journaling failed",
      err
    );
  }

  return { ...report, auditRecorded };
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

  if (completed) {
    /*
     * The journal payload is untrusted JSON: parse and validate
     * it before trusting ALREADY_COMPLETED. Only a valid array
     * of non-empty strings that COVERS the current claim may
     * short-circuit. A malformed or stale journal entry falls
     * through to a full apply attempt — the in-transaction
     * checks remain authoritative either way.
     */
    const journalPhoneIds = parseJournalPhoneIds(
      completed.phoneNumberIds
    );

    if (journalPhoneIds) {
      const transferred = new Set(journalPhoneIds);
      const claimed = normalizePhoneIdSet(preReport.phoneNumberIds);

      const coversClaim = [...claimed].every((id) =>
        transferred.has(id)
      );

      if (
        coversClaim &&
        wabaIdsAgree(
          completed.wabaId,
          preReport.wabaId,
          preReport.destinationConnection?.wabaId ?? null
        )
      ) {
        const counts = recoverJournalCounts(completed);

        if (!counts) {
          throw new TransferAbortError(
            "JOURNAL_STATE_INVALID",
            "Completed transfer journal has no trustworthy message count; manual review required",
            { journalId: completed.id }
          );
        }

        return {
          status: "ALREADY_COMPLETED",
          journalId: completed.id,
          report: preReport,
          conversationCount: counts.conversationCount,
          messageCount: counts.messageCount,
          evictedSockets: 0,
        };
      }
    }
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

  if (!preReport.destinationConnection.isActive) {
    throw new TransferAbortError(
      "DESTINATION_CONNECTION_INACTIVE",
      "Destination seller WhatsApp connection is not active; connect WhatsApp before transferring"
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

  let result: {
    journalId: string;
    report: TransferReport;
    conversationIds: number[];
  };

  try {
    result = await prisma.$transaction(
    async (tx) => {
      for (const phoneNumberId of sortedPhoneIds) {
        await acquirePhoneNumberLock(tx, phoneNumberId);
      }

      const report = await buildTransferReport(
        tx,
        sourceSellerId,
        destinationSellerId
      );

      /*
       * Validate the SOURCE connection inside the transaction,
       * before any business-data writes. Its id must match the
       * connection that was reviewed — a different or missing
       * connection means the world changed under us: abort.
       */
      const sourceConnection = report.sourceConnection;

      if (!sourceConnection) {
        throw new TransferAbortError(
          "SOURCE_CONNECTION_MISSING",
          "Source seller WhatsApp connection disappeared; aborting"
        );
      }

      if (!sourceConnection.isActive) {
        throw new TransferAbortError(
          "SOURCE_CONNECTION_INACTIVE",
          "Source seller WhatsApp connection is no longer active; aborting"
        );
      }

      const reviewedSourceConnectionId =
        preReport.sourceConnection?.id;

      if (
        reviewedSourceConnectionId === undefined ||
        sourceConnection.id !== reviewedSourceConnectionId
      ) {
        throw new TransferAbortError(
          "SOURCE_CONNECTION_MISSING",
          "Source WhatsApp connection changed between review and apply; re-run the dry run"
        );
      }

      const sourceConnectionId = sourceConnection.id;

      /*
       * Exact-ownership verification: every transferred phone
       * number must be actively owned by EXACTLY the source
       * connection AND the source seller right now. An absent,
       * ambiguous or foreign-owned mapping aborts the transfer.
       */
      for (const phoneNumberId of sortedPhoneIds) {
        const activeRows =
          await tx.whatsAppPhoneOwnership.findMany({
            where: {
              phoneNumberId,
              isActive: true,
            },
            select: { connectionId: true, sellerId: true },
          });

        if (
          activeRows.length !== 1 ||
          activeRows[0].connectionId !== sourceConnectionId ||
          activeRows[0].sellerId !== sourceSellerId
        ) {
          throw new TransferAbortError(
            "OWNERSHIP_MAPPING_INVALID",
            "A transferred phone number is not actively owned by the source connection; aborting",
            {
              phoneNumberId,
              activeOwnerConnectionId: activeRows[0]?.connectionId ?? null,
              activeOwnerSellerId: activeRows[0]?.sellerId ?? null,
              activeRowCount: activeRows.length,
            }
          );
        }
      }

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

        /*
         * Resolve the DESTINATION-owned customer safely:
         *   1. by phone (exact match within the destination
         *      seller). Multiple matches = ambiguous mapping:
         *      abort rather than picking arbitrarily.
         *   2. otherwise by email, same ambiguity rule; the
         *      matched customer must not already belong to a
         *      DIFFERENT phone (that would silently rewrite
         *      someone else's customer record).
         *   3. otherwise create a new destination-owned customer.
         *
         * If the conversation HAD a customer but has neither
         * phone nor email to resolve or create by, abort — an
         * existing customer relationship must never be silently
         * set to null. A conversation that never had a customer
         * keeps null.
         */
        let newCustomerId: number | null = null;

        if (conversation.customerPhone) {
          const byPhone =
            await tx.customer.findMany({
              where: {
                sellerId: destinationSellerId,
                phone: conversation.customerPhone,
              },
              select: { id: true, email: true },
            });

          if (byPhone.length > 1) {
            throw new TransferAbortError(
              "DESTINATION_CUSTOMER_MAPPING_AMBIGUOUS",
              "Multiple destination customers match this phone; resolve manually before transferring",
              {
                conversationId: conversation.id,
                phone: conversation.customerPhone,
                matchCount: byPhone.length,
              }
            );
          }

          if (byPhone.length === 1) {
            newCustomerId = byPhone[0].id;
          } else if (conversation.customerEmail) {
            const byEmail =
              await tx.customer.findMany({
                where: {
                  sellerId: destinationSellerId,
                  email: conversation.customerEmail,
                },
                select: { id: true, phone: true },
              });

            if (byEmail.length > 1) {
              throw new TransferAbortError(
                "DESTINATION_CUSTOMER_MAPPING_AMBIGUOUS",
                "Multiple destination customers match this email; resolve manually before transferring",
                {
                  conversationId: conversation.id,
                  email: conversation.customerEmail,
                  matchCount: byEmail.length,
                }
              );
            }

            if (
              byEmail.length === 1 &&
              byEmail[0].phone === null
            ) {
              // Same person, phone missing on the existing row:
              // fill the phone in rather than duplicating.
              await tx.customer.update({
                where: { id: byEmail[0].id },
                data: { phone: conversation.customerPhone },
              });

              newCustomerId = byEmail[0].id;
            } else if (byEmail.length === 1) {
              throw new TransferAbortError(
                "DESTINATION_CUSTOMER_MAPPING_AMBIGUOUS",
                "Destination customer with this email already has a different phone; resolve manually",
                {
                  conversationId: conversation.id,
                  email: conversation.customerEmail,
                  existingPhone: byEmail[0].phone,
                }
              );
            }
          }

          if (newCustomerId === null) {
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
        } else if (conversation.customerEmail) {
          const byEmail = await tx.customer.findMany({
            where: {
              sellerId: destinationSellerId,
              email: conversation.customerEmail,
            },
            select: { id: true },
          });

          if (byEmail.length > 1) {
            throw new TransferAbortError(
              "DESTINATION_CUSTOMER_MAPPING_AMBIGUOUS",
              "Multiple destination customers match this email; resolve manually before transferring",
              {
                conversationId: conversation.id,
                email: conversation.customerEmail,
                matchCount: byEmail.length,
              }
            );
          }

          if (byEmail.length === 1) {
            newCustomerId = byEmail[0].id;
          } else {
            const created = await tx.customer.create({
              data: {
                sellerId: destinationSellerId,
                name: conversation.customerName,
                phone: null,
                email: conversation.customerEmail,
              },
            });

            newCustomerId = created.id;
          }
        } else if (conversation.customerId !== null) {
          throw new TransferAbortError(
            "DESTINATION_CUSTOMER_MAPPING_AMBIGUOUS",
            "Conversation has a customer but neither phone nor email to resolve the destination mapping; aborting instead of dropping the relationship",
            { conversationId: conversation.id }
          );
        // customerId was already null: no relationship to drop.
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
          where: { id: sourceConnectionId },
          select: { metadata: true },
        });

      await tx.channelConnection.update({
        where: { id: sourceConnectionId },
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
              id: sourceConnectionId,
              isActive: true,
              connectionStatus:
                sourceConnection.connectionStatus,
            },
            sourceConnectionAfter: {
              id: sourceConnectionId,
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
  } catch (error) {
    if (error instanceof TransferAbortError) {
      throw error;
    }

    /*
     * Concurrency safety: a unique-constraint violation (P2002,
     * e.g. another apply created the active ownership row first)
     * or a serialization/write conflict (P2034) means another
     * transfer or webhook raced us. The transaction rolled back
     * atomically — surface a typed, retryable error instead of
     * an opaque database failure.
     */
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      /*
       * P2034: serialization / write conflict — the transaction
       * rolled back atomically. Typed and retryable.
       */
      if (error.code === "P2034") {
        throw new TransferAbortError(
          "CONCURRENT_TRANSFER_CONFLICT",
          "A concurrent transfer or webhook modified the same rows; the transaction rolled back — retry the dry run and apply",
          { prismaCode: error.code }
        );
      }

      /*
       * P2002: classify ONLY a violation of the phone-ownership
       * active-owner partial unique index as an ownership race.
       * Unrelated uniqueness errors (e.g. customer or
       * conversation constraints) are rethrown untouched —
       * misreporting them as ownership conflicts would hide the
       * real cause.
       */
      if (error.code === "P2002") {
        const target = (error.meta?.target as unknown[] | string | undefined) ?? error.meta?.constraint;

        const isOwnershipConstraint = Array.isArray(target)
          ? target.some(
              (entry) =>
                typeof entry === "string" &&
                entry.includes(
                  "WhatsAppPhoneOwnership_phoneNumberId_active_key"
                )
            )
          : typeof target === "string" &&
            target.includes(
              "WhatsAppPhoneOwnership_phoneNumberId_active_key"
            );

        if (isOwnershipConstraint) {
          throw new TransferAbortError(
            "CONCURRENT_TRANSFER_CONFLICT",
            "A concurrent transfer raced the phone-ownership unique index; the transaction rolled back — retry the dry run and apply",
            { prismaCode: error.code }
          );
        }
      }
    }

    throw error;
  }

  // ---- Post-commit realtime revocation ----

  /*
   * Validate the conversation IDs before evicting any room:
   * unique positive safe integers whose count matches the
   * recorded conversation count. Untrusted state aborts for
   * manual review instead of evicting arbitrary rooms.
   */
  const evictionIds = validateEvictionConversationIds(
    result.conversationIds,
    result.report.conversationCount
  );

  if (!evictionIds) {
    throw new TransferAbortError(
      "JOURNAL_STATE_INVALID",
      "Transfer completed but its conversation list is invalid; socket eviction was skipped — manual review required",
      { journalId: result.journalId }
    );
  }

  const evictedSockets = await evictSocketsFromConversations(
    input.io,
    evictionIds,
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

