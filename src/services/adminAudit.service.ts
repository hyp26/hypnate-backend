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

interface RecordAuditInput {
  actorId: number | null;
  action: AuditActionValue;
  entityType?: string;
  entityId?: string | number;
  oldValue?: unknown;
  newValue?: unknown;
  req?: Request;
}

/**
 * Persist an audit trail entry for a privileged admin action.
 *
 * Audit writes must never break the request they describe, so
 * failures are logged and swallowed.
 */
export const recordAudit = async (input: RecordAuditInput): Promise<void> => {
  try {
    await prisma.auditLog.create({
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
