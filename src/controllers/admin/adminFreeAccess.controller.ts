import { Response, NextFunction } from "express";
import prisma from "../../prisma/client";
import { AdminAuthRequest } from "../../middleware/adminAuth.middleware";
import {
  grantFreeAccessSchema,
  updateFreeAccessSchema,
  revokeFreeAccessSchema,
} from "../../schemas/admin.schemas";
import { recordAudit } from "../../services/adminAudit.service";
import { getPlanAccess } from "../../services/billing.service";

/* ----------------------------------------------------
   HELPERS
---------------------------------------------------- */

const parseSellerId = (req: AdminAuthRequest): number | null => {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
};

/**
 * Grant state captured in the audit trail. Contains no
 * credentials, tokens, or payment data.
 */
const serializeGrantForAudit = (grant: {
  id: number;
  plan: string;
  expiresAt: Date | null;
  reason: string;
  revokedAt: Date | null;
} | null) =>
  grant
    ? {
        id: grant.id,
        plan: grant.plan,
        expiresAt: grant.expiresAt ? grant.expiresAt.toISOString() : null,
        reason: grant.reason,
        revokedAt: grant.revokedAt ? grant.revokedAt.toISOString() : null,
      }
    : null;

/**
 * Loads the billing-relevant seller state together with the
 * active grant so the response reports the EFFECTIVE access
 * decided by getPlanAccess (the same rules the plan
 * middleware and billing-status endpoint use).
 */
const loadEffectiveAccess = async (sellerId: number) => {
  const seller = await prisma.seller.findUnique({
    where: { id: sellerId },
    select: {
      id: true,
      businessName: true,
      status: true,
      selectedPlan: true,
      trialPlan: true,
      trialStartedAt: true,
      trialEndsAt: true,
      activePlan: true,
      planStatus: true,
      planActivatedAt: true,
      planCurrentPeriodEnd: true,
      freeAccessGrants: {
        where: { revokedAt: null },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          id: true,
          plan: true,
          expiresAt: true,
          reason: true,
          createdAt: true,
        },
      },
    },
  });

  if (!seller) {
    return null;
  }

  const activeGrant = seller.freeAccessGrants[0] ?? null;
  const access = getPlanAccess({ ...seller, freeAccessGrant: activeGrant });

  return {
    seller,
    activeGrant,
    access,
    payload: {
      access,
      effectivePlan: access.plan,
      accessSource: access.source,
      adminGrant: activeGrant
        ? {
            id: activeGrant.id,
            plan: activeGrant.plan,
            expiresAt: activeGrant.expiresAt,
            reason: activeGrant.reason,
            grantedAt: activeGrant.createdAt,
          }
        : null,
    },
  };
};

/* ----------------------------------------------------
   POST /api/admin/sellers/:id/free-access
---------------------------------------------------- */

/**
 * Grant (or replace) a free-access grant for a seller.
 *
 * A grant NEVER touches the paid-subscription or trial fields
 * on Seller and never creates Razorpay artifacts. The partial
 * unique index SellerFreeAccessGrant_sellerId_active_key
 * guarantees at most one active grant per seller: a repeated
 * request replaces the existing active grant in one transaction.
 */
export const grantFreeAccess = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = parseSellerId(req);

    if (!sellerId) {
      res.status(400).json({ message: "Invalid seller id" });
      return;
    }

    const parsed = grantFreeAccessSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        message: parsed.error.issues[0]?.message ?? "Invalid request",
      });
      return;
    }

    const { plan, expiresAt, reason } = parsed.data;
    const actorId = req.adminUser!.id;

    const seller = await prisma.seller.findUnique({
      where: { id: sellerId },
      select: { id: true },
    });

    if (!seller) {
      res.status(404).json({ message: "Seller not found" });
      return;
    }

    const grant = await prisma.$transaction(async (tx) => {
      const existing = await tx.sellerFreeAccessGrant.findFirst({
        where: { sellerId, revokedAt: null },
      });

      const data = {
        plan,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        reason,
        grantedByAdminId: actorId,
      };

      const result = existing
        ? await tx.sellerFreeAccessGrant.update({
            where: { id: existing.id },
            data,
          })
        : await tx.sellerFreeAccessGrant.create({
            data: { ...data, sellerId },
          });

      // Audit entry is written INSIDE the transaction so a grant
      // change and its audit trail commit (or roll back) together.
      await recordAudit({
        actorId,
        action: existing ? "UPDATE" : "CREATE",
        entityType: "SellerFreeAccessGrant",
        entityId: sellerId,
        oldValue: serializeGrantForAudit(existing),
        newValue: {
          ...serializeGrantForAudit(result),
          sellerId,
        },
        req,
        tx,
      });

      return result;
    });

    const effective = await loadEffectiveAccess(sellerId);

    res.status(201).json({
      message: "Free access granted",
      grant: serializeGrantForAudit(grant),
      ...effective!.payload,
      seller: {
        id: effective!.seller.id,
        businessName: effective!.seller.businessName,
        status: effective!.seller.status,
      },
    });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   PATCH /api/admin/sellers/:id/free-access
---------------------------------------------------- */

/**
 * Change the plan and/or expiration of the active grant.
 * Requires a reason; every change is audited.
 */
export const updateFreeAccess = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = parseSellerId(req);

    if (!sellerId) {
      res.status(400).json({ message: "Invalid seller id" });
      return;
    }

    const parsed = updateFreeAccessSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        message: parsed.error.issues[0]?.message ?? "Invalid request",
      });
      return;
    }

    const { plan, expiresAt, reason } = parsed.data;
    const actorId = req.adminUser!.id;

    const updated = await prisma.$transaction(async (tx) => {
      const existing = await tx.sellerFreeAccessGrant.findFirst({
        where: { sellerId, revokedAt: null },
      });

      if (!existing) {
        return null;
      }

      const data: {
        plan?: string;
        expiresAt?: Date | null;
        reason: string;
      } = { reason };

      if (plan !== undefined) {
        data.plan = plan;
      }

      if (expiresAt !== undefined) {
        data.expiresAt = expiresAt === null ? null : new Date(expiresAt);
      }

      const result = await tx.sellerFreeAccessGrant.update({
        where: { id: existing.id },
        data,
      });

      await recordAudit({
        actorId,
        action: "UPDATE",
        entityType: "SellerFreeAccessGrant",
        entityId: sellerId,
        oldValue: serializeGrantForAudit(existing),
        newValue: {
          ...serializeGrantForAudit(result),
          sellerId,
        },
        req,
        tx,
      });

      return result;
    });

    if (!updated) {
      res
        .status(404)
        .json({ message: "No active free-access grant for this seller" });
      return;
    }

    const effective = await loadEffectiveAccess(sellerId);

    res.json({
      message: "Free access updated",
      grant: serializeGrantForAudit(updated),
      ...effective!.payload,
      seller: {
        id: effective!.seller.id,
        businessName: effective!.seller.businessName,
        status: effective!.seller.status,
      },
    });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   DELETE /api/admin/sellers/:id/free-access
---------------------------------------------------- */

/**
 * Revoke the active grant. The grant row is retained (with
 * revokedAt / revokedByAdminId) for audit history. Requires a
 * reason; the revocation is audited.
 */
export const revokeFreeAccess = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = parseSellerId(req);

    if (!sellerId) {
      res.status(400).json({ message: "Invalid seller id" });
      return;
    }

    const parsed = revokeFreeAccessSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        message: parsed.error.issues[0]?.message ?? "Invalid request",
      });
      return;
    }

    const { reason } = parsed.data;
    const actorId = req.adminUser!.id;

    const revoked = await prisma.$transaction(async (tx) => {
      const existing = await tx.sellerFreeAccessGrant.findFirst({
        where: { sellerId, revokedAt: null },
      });

      if (!existing) {
        return null;
      }

      const result = await tx.sellerFreeAccessGrant.update({
        where: { id: existing.id },
        data: {
          revokedAt: new Date(),
          revokedByAdminId: actorId,
        },
      });

      await recordAudit({
        actorId,
        // The AuditAction DB enum has no REVOKE value; UPDATE with
        // an explicit revokedAt in newValue records it unambiguously.
        action: "UPDATE",
        entityType: "SellerFreeAccessGrant",
        entityId: sellerId,
        oldValue: serializeGrantForAudit(existing),
        newValue: {
          ...serializeGrantForAudit(result),
          sellerId,
          revoked: true,
          revocationReason: reason,
        },
        req,
        tx,
      });

      return result;
    });

    if (!revoked) {
      res
        .status(404)
        .json({ message: "No active free-access grant for this seller" });
      return;
    }

    const effective = await loadEffectiveAccess(sellerId);

    res.json({
      message: "Free access revoked",
      grant: serializeGrantForAudit(revoked),
      ...effective!.payload,
      seller: {
        id: effective!.seller.id,
        businessName: effective!.seller.businessName,
        status: effective!.seller.status,
      },
    });
  } catch (err) {
    next(err);
  }
};
