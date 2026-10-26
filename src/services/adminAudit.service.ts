import { Request } from "express";
import prisma from "../prisma/client";
import { logger } from "../utils/logger";

type AuditActionValue =
  | "CREATE"
  | "UPDATE"
  | "DELETE"
  | "LOGIN"
  | "LOGOUT"
  | "SETTINGS";

/**
 * Minimal structural type accepted as a transaction-scoped
 * Prisma client. Method parameter positions are bivariant in
 * TypeScript, so both `prisma` and a `prisma.$transaction` tx
 * client satisfy this interface.
 */
interface AuditLogClient {
  auditLog: {
    create(args: unknown): Promise<unknown>;
  };
}

interface RecordAuditInput {
  actorId: number | null;
  action: AuditActionValue;
  entityType?: string;
  entityId?: string | number;
  oldValue?: unknown;
  newValue?: unknown;
  req?: Request;
  /**
   * Optional transaction-scoped client. When supplied, the audit
   * row is written INSIDE the caller's transaction, so a
   * privileged change and its audit entry commit (or roll back)
   * together. Without it, the global client is used and the
   * write remains fire-and-forget.
   */
  tx?: AuditLogClient;
}

/**
 * Persist an audit trail entry for a privileged admin action.
 *
 * When called without a transaction client, audit writes must
 * never break the request they describe, so failures are logged
 * and swallowed. When a `tx` client is supplied, failures
 * propagate so the enclosing transaction rolls back.
 */
export const recordAudit = async (input: RecordAuditInput): Promise<void> => {
  const client: AuditLogClient = input.tx ?? prisma;

  try {
    await client.auditLog.create({
      data: {
        adminUserId: input.actorId ?? null,
        action: input.action,
        entityType: input.entityType ?? null,
        entityId:
          input.entityId !== undefined && input.entityId !== null
            ? String(input.entityId)
            : null,
        oldValue:
          input.oldValue === undefined ? undefined : (input.oldValue as object),
        newValue:
          input.newValue === undefined ? undefined : (input.newValue as object),
        ipAddress: input.req?.ip ?? null,
        userAgent: input.req?.get("user-agent") ?? null,
      },
    });
  } catch (err) {
    if (input.tx) {
      // Inside a caller-supplied transaction: propagate so the
      // privileged change and its audit entry stay atomic.
      throw err;
    }
    logger.error("Failed to write admin audit log", err);
  }
};

/**
 * Redact password fields before putting a record into the
 * audit trail.
 */
export const redactForAudit = (
  value: Record<string, unknown> | null | undefined
): Record<string, unknown> | null => {
  if (!value) {
    return null;
  }

  const copy = { ...value };
  delete copy.passwordHash;
  delete copy.password;
  return copy;
};
