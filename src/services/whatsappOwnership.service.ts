import { Prisma } from "@prisma/client";
import prisma from "../prisma/client";
import { logger } from "../utils/logger";

/*
 * Normalized WhatsApp phone-number ownership.
 *
 * The WhatsAppPhoneOwnership table is the single authoritative
 * mapping of each WhatsApp phone-number ID to the one
 * ChannelConnection that owns it. A partial unique index
 * (phoneNumberId WHERE isActive) enforces at most one ACTIVE
 * owner per phone number at the database level.
 *
 * Inbound routing must resolve ownership ONLY through this
 * mapping and fail closed on unknown/ambiguous numbers — never
 * by scanning connection metadata for a first match.
 *
 * SECURITY (audit finding H-3): ownership can only CHANGE
 * hands through the administrative transfer workflow. The
 * OAuth reconnect path (syncConnectionOwnership) REJECTS any
 * claim to a phone number that is actively owned by another
 * connection — it never deactivates another seller's active
 * ownership row and never silently inserts a second owner.
 */

export type OwnershipTx = Prisma.TransactionClient | typeof prisma;

export type PhoneOwnershipErrorCode =
  | "UNKNOWN_PHONE_NUMBER"
  | "AMBIGUOUS_PHONE_OWNERSHIP"
  | "OWNER_CONNECTION_INACTIVE"
  | "PHONE_OWNERSHIP_CONFLICT"
  | "PHONE_NOT_OWNED_BY_SELLER";

export class PhoneOwnershipError extends Error {
  constructor(
    public readonly code: PhoneOwnershipErrorCode,
    message: string
  ) {
    super(message);
    this.name = "PhoneOwnershipError";
  }
}

export type ResolvedOwner = {
  connectionId: number;
  sellerId: number;
};

/*
 * Extract every phone-number ID a connection's metadata claims,
 * from BOTH supported shapes:
 *   - metadata.phoneNumbers: [{ id | phone_number_id, ... }]
 *   - metadata.phoneNumberIds: ["...", ...]
 * Deduplicated, order-preserving, empty/malformed entries skipped.
 * Pure function — used by routing, the backfill plan, and tests.
 */
export const extractPhoneNumberIds = (
  metadata: unknown
): string[] => {
  const result: string[] = [];
  const record = (metadata ?? {}) as Record<string, unknown>;

  const push = (value: unknown) => {
    if (typeof value !== "string" && typeof value !== "number") {
      return;
    }

    const id = String(value).trim();

    if (id && !result.includes(id)) {
      result.push(id);
    }
  };

  if (Array.isArray(record.phoneNumberIds)) {
    record.phoneNumberIds.forEach(push);
  }

  if (Array.isArray(record.phoneNumbers)) {
    record.phoneNumbers.forEach((phone) => {
      if (!phone || typeof phone !== "object") {
        return;
      }

      const value = phone as Record<string, unknown>;
      push(value.id ?? value.phone_number_id);
    });
  }

  return result;
};

/*
 * Deterministic backfill plan for existing active WHATSAPP
 * connections (same rule as the SQL migration):
 *
 *   connections are visited in ascending id order — the SAME
 *   order the previous first-match routing used — so the
 *   connection that owns routing today remains the canonical
 *   owner. Later connections claiming an already-assigned phone
 *   number are reported as conflicts, never silently chosen
 *   and never deleted.
 */
export type BackfillConnection = {
  id: number;
  sellerId: number;
  wabaId: string | null;
  metadata: unknown;
};

export type BackfillPlan = {
  assignments: Array<{
    phoneNumberId: string;
    connectionId: number;
    sellerId: number;
    wabaId: string | null;
  }>;
  conflicts: Array<{
    phoneNumberId: string;
    canonicalConnectionId: number;
    conflictingConnectionIds: number[];
  }>;
};

export const buildBackfillPlan = (
  connections: BackfillConnection[]
): BackfillPlan => {
  const ordered = [...connections].sort((a, b) => a.id - b.id);

  const assignments: BackfillPlan["assignments"] = [];
  const conflicts: BackfillPlan["conflicts"] = [];
  const assignedTo = new Map<string, number>();

  for (const connection of ordered) {
    for (const phoneNumberId of extractPhoneNumberIds(
      connection.metadata
    )) {
      const existing = assignedTo.get(phoneNumberId);

      if (existing === undefined) {
        assignedTo.set(phoneNumberId, connection.id);

        assignments.push({
          phoneNumberId,
          connectionId: connection.id,
          sellerId: connection.sellerId,
          wabaId: connection.wabaId,
        });

        continue;
      }

      const conflict = conflicts.find(
        (entry) => entry.phoneNumberId === phoneNumberId
      );

      if (conflict) {
        if (!conflict.conflictingConnectionIds.includes(connection.id)) {
          conflict.conflictingConnectionIds.push(connection.id);
        }
      } else {
        conflicts.push({
          phoneNumberId,
          canonicalConnectionId: existing,
          conflictingConnectionIds: [connection.id],
        });
      }
    }
  }

  return { assignments, conflicts };
};

/*
 * Per-phone-number transaction lock shared by webhook processing,
 * ownership transfer, OAuth ownership sync, and outbound send
 * verification. pg_advisory_xact_lock is held until the
 * surrounding transaction commits or rolls back, so a webhook that
 * resolves ownership cannot race a concurrent transfer: whichever
 * takes the lock first finishes its ENTIRE durable write before
 * the other may proceed.
 */
export const acquirePhoneNumberLock = async (
  tx: OwnershipTx,
  phoneNumberId: string
): Promise<void> => {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${phoneNumberId}))`;
};

/*
 * Resolve the single authoritative owner of a phone number.
 * FAIL CLOSED:
 *   - no active ownership row        → UNKNOWN_PHONE_NUMBER
 *   - more than one active row      → AMBIGUOUS_PHONE_OWNERSHIP
 *     (should be impossible under the partial unique index, but
 *     checked anyway — defense in depth)
 *   - owning connection not active  → OWNER_CONNECTION_INACTIVE
 * Never returns an arbitrary seller.
 */
export const resolveActiveOwner = async (
  tx: OwnershipTx,
  phoneNumberId: string
): Promise<ResolvedOwner> => {
  const rows = await tx.whatsAppPhoneOwnership.findMany({
    where: {
      phoneNumberId,
      isActive: true,
    },
    select: {
      connectionId: true,
      sellerId: true,
    },
    orderBy: {
      connectionId: "asc",
    },
  });

  if (rows.length === 0) {
    throw new PhoneOwnershipError(
      "UNKNOWN_PHONE_NUMBER",
      "No active owner for this WhatsApp phone number"
    );
  }

  if (rows.length > 1) {
    throw new PhoneOwnershipError(
      "AMBIGUOUS_PHONE_OWNERSHIP",
      "Multiple active owners for this WhatsApp phone number"
    );
  }

  const owner = rows[0];

  const connection = await tx.channelConnection.findFirst({
    where: {
      id: owner.connectionId,
      platform: "WHATSAPP",
      isActive: true,
    },
    select: {
      id: true,
      sellerId: true,
    },
  });

  if (!connection) {
    throw new PhoneOwnershipError(
      "OWNER_CONNECTION_INACTIVE",
      "The owning WhatsApp connection is no longer active"
    );
  }

  return {
    connectionId: connection.id,
    sellerId: connection.sellerId,
  };
};

/*
 * Align the ownership rows of a connection with the phone numbers
 * its CURRENT metadata claims (used after OAuth connect/refresh).
 *
 * SECURITY INVARIANT (audit finding H-3): a reconnect can only
 * (re)activate ownership rows for phone numbers that are NOT
 * actively owned by a DIFFERENT connection. If any claimed number
 * is actively owned by another connection — whether it belongs to
 * another seller OR to the same seller — the whole sync aborts
 * with PhoneOwnershipError("PHONE_OWNERSHIP_CONFLICT") and the
 * caller's transaction rolls back. The existing owner's mapping
 * is never weakened, and no second active owner can be created.
 * Legitimate cross-seller moves must go through the
 * administrative transfer workflow.
 *
 * Locking: the advisory locks for every involved phone number
 * (newly claimed numbers AND this connection's previously active
 * numbers) are acquired FIRST, in deterministic sorted order, and
 * ownership is re-read AFTER the locks — a pre-lock ownership
 * lookup is never trusted. This makes the sync mutually excluded
 * with concurrent webhooks, disconnects, transfers, and other
 * reconnects on the same numbers.
 *
 * Cleanup of numbers that disappeared from this connection's
 * metadata only ever deactivates THIS connection's own rows,
 * scoped by connectionId, so it can never weaken another
 * connection's ownership.
 */
export const syncConnectionOwnership = async (
  tx: OwnershipTx,
  connection: {
    id: number;
    sellerId: number;
    metadata: unknown;
  },
  wabaId: string | null
): Promise<void> => {
  const claimedIds = extractPhoneNumberIds(connection.metadata);

  /*
   * Lock every phone number involved in this sync: the newly
   * claimed numbers plus this connection's currently active
   * numbers (which may need cleanup). Deterministic sorted order
   * prevents deadlocks between concurrent syncs.
   */
  const previouslyActiveRows = await tx.whatsAppPhoneOwnership.findMany({
    where: {
      connectionId: connection.id,
      isActive: true,
    },
    select: {
      phoneNumberId: true,
    },
  });

  const lockIds = [
    ...new Set([
      ...claimedIds,
      ...previouslyActiveRows.map((row) => row.phoneNumberId),
    ]),
  ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  for (const phoneNumberId of lockIds) {
    await acquirePhoneNumberLock(tx, phoneNumberId);
  }

  /*
   * Re-read the CURRENT active owners of every claimed number
   * AFTER the locks are held. Any active row belonging to a
   * different connection is a conflict — including one that
   * belongs to the same seller (no implicit same-seller
   * reconciliation policy exists; the administrative transfer
   * workflow is the only ownership-changing path).
   */
  const activeOwnerRows = await tx.whatsAppPhoneOwnership.findMany({
    where: {
      phoneNumberId: { in: claimedIds },
      isActive: true,
    },
    select: {
      phoneNumberId: true,
      connectionId: true,
      sellerId: true,
    },
    orderBy: {
      connectionId: "asc",
    },
  });

  for (const row of activeOwnerRows) {
    if (row.connectionId === connection.id) {
      // Our own row: reactivating it below is safe.
      continue;
    }

    throw new PhoneOwnershipError(
      "PHONE_OWNERSHIP_CONFLICT",
      `WhatsApp phone number ${row.phoneNumberId} is actively owned by connection ${row.connectionId} (seller ${row.sellerId}); reconnect rejected — use the administrative transfer workflow`
    );
  }

  for (const phoneNumberId of claimedIds) {
    const existing = await tx.whatsAppPhoneOwnership.findFirst({
      where: {
        phoneNumberId,
        connectionId: connection.id,
      },
      select: { id: true },
    });

    if (existing) {
      await tx.whatsAppPhoneOwnership.update({
        where: { id: existing.id },
        data: { isActive: true, sellerId: connection.sellerId, wabaId },
      });
    } else {
      await tx.whatsAppPhoneOwnership.create({
        data: {
          phoneNumberId,
          connectionId: connection.id,
          sellerId: connection.sellerId,
          wabaId,
          isActive: true,
        },
      });
    }
  }

  /*
   * Deactivate this connection's own rows for numbers that are
   * no longer claimed. Scoped strictly to this connectionId —
   * another connection's ownership is never touched.
   */
  if (claimedIds.length > 0) {
    await tx.whatsAppPhoneOwnership.updateMany({
      where: {
        connectionId: connection.id,
        isActive: true,
        phoneNumberId: { notIn: claimedIds },
      },
      data: { isActive: false },
    });
  } else {
    await tx.whatsAppPhoneOwnership.updateMany({
      where: {
        connectionId: connection.id,
        isActive: true,
      },
      data: { isActive: false },
    });
  }
};

/*
 * Outbound-send ownership guard (audit finding H-3).
 *
 * Verifies — under the same per-phone advisory lock used by
 * webhooks, transfers, and OAuth sync — that the phone number is
 * actively owned by EXACTLY the requesting seller's connection
 * before any message is submitted to Meta. Re-reads ownership
 * after acquiring the lock, so a stale pre-lock lookup cannot
 * authorize a send.
 *
 * Throws:
 *   - UNKNOWN_PHONE_NUMBER / AMBIGUOUS_PHONE_OWNERSHIP /
 *     OWNER_CONNECTION_INACTIVE via resolveActiveOwner
 *   - PHONE_NOT_OWNED_BY_SELLER when the active owner is a
 *     different seller or a different connection than the one
 *     whose credential will be used.
 */
export const assertOwnedPhoneNumberForSend = async (
  tx: OwnershipTx,
  params: {
    sellerId: number;
    connectionId: number;
    phoneNumberId: string;
  }
): Promise<ResolvedOwner> => {
  await acquirePhoneNumberLock(tx, params.phoneNumberId);

  const owner = await resolveActiveOwner(tx, params.phoneNumberId);

  if (owner.sellerId !== params.sellerId) {
    throw new PhoneOwnershipError(
      "PHONE_NOT_OWNED_BY_SELLER",
      `WhatsApp phone number ${params.phoneNumberId} is actively owned by another seller`
    );
  }

  if (owner.connectionId !== params.connectionId) {
    throw new PhoneOwnershipError(
      "PHONE_NOT_OWNED_BY_SELLER",
      `WhatsApp phone number ${params.phoneNumberId} is actively owned by a different connection`
    );
  }

  return owner;
};

/*
 * Deactivate every active ownership row of a connection
 * (disconnect / transfer). Rows are kept for audit history.
 */
export const deactivateOwnershipForConnection = async (
  tx: OwnershipTx,
  connectionId: number
): Promise<number> => {
  const result = await tx.whatsAppPhoneOwnership.updateMany({
    where: {
      connectionId,
      isActive: true,
    },
    data: { isActive: false },
  });

  return result.count;
};

/*
 * Whether any OTHER active WhatsApp connection references the same
 * WABA id (from externalAccountId or metadata.whatsappBusinessId).
 * Used to guard Meta's app-level WABA unsubscribe: when a second
 * seller still needs the WABA's webhook subscription, disconnecting
 * one seller's connection must NOT unsubscribe the app.
 */
export const hasOtherActiveWabaConnection = async (
  tx: OwnershipTx,
  wabaId: string,
  excludeConnectionId: number
): Promise<boolean> => {
  const count = await tx.channelConnection.count({
    where: {
      platform: "WHATSAPP",
      isActive: true,
      id: { not: excludeConnectionId },
      OR: [
        { externalAccountId: wabaId },
        { metadata: { path: ["whatsappBusinessId"], equals: wabaId } },
      ],
    },
  });

  return count > 0;
};

/*
 * Read-only conflict report across ALL active WhatsApp
 * connections (used by transfer dry-runs and operations tooling).
 * For each phone number claimed by more than one active
 * connection, report the canonical owner and every conflicting
 * connection. No writes.
 */
export const reportOwnershipConflicts = async () => {
  const connections = await prisma.channelConnection.findMany({
    where: {
      platform: "WHATSAPP",
      isActive: true,
    },
    select: {
      id: true,
      sellerId: true,
      externalAccountId: true,
      metadata: true,
    },
    orderBy: {
      id: "asc",
    },
  });

  const plan = buildBackfillPlan(
    connections.map((connection) => ({
      id: connection.id,
      sellerId: connection.sellerId,
      wabaId: connection.externalAccountId,
      metadata: connection.metadata,
    }))
  );

  if (plan.conflicts.length) {
    logger.warn(
      "WhatsApp phone-number ownership conflicts detected",
      {
        conflictCount: plan.conflicts.length,
      }
    );
  }

  return plan;
};
