import { Request, Response, NextFunction } from "express";
import bcrypt from "bcrypt";
import prisma from "../../prisma/client";
import { AdminAuthRequest } from "../../middleware/adminAuth.middleware";
import {
  createAdminAccountSchema,
  updateAdminRoleSchema,
  updateAdminStatusSchema,
} from "../../schemas/admin.schemas";
import { recordAudit, redactForAudit } from "../../services/adminAudit.service";

/* ----------------------------------------------------
   HELPERS
---------------------------------------------------- */

const PUBLIC_FIELDS = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  role: true,
  status: true,
  avatarUrl: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Mirrors the frontend's canManageTarget rule:
 *
 *  - nobody manages a SUPER_ADMIN (except the seed script)
 *  - nobody manages their own role/status/account
 *  - ADMIN can only manage SUPPORT accounts
 */
const canManageTarget = (
  actor: { id: number; role: string },
  target: { id: number; role: string }
): boolean => {
  if (actor.id === target.id) return false;
  if (target.role === "SUPER_ADMIN") return false;
  if (actor.role === "SUPER_ADMIN") return true;
  return actor.role === "ADMIN" && target.role === "SUPPORT";
};

/* ----------------------------------------------------
   GET /api/admin/users
---------------------------------------------------- */

export const listAdminUsers = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const admins = await prisma.adminUser.findMany({
      select: PUBLIC_FIELDS,
      orderBy: [{ role: "asc" }, { createdAt: "desc" }],
    });

    res.json({ data: admins });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   POST /api/admin/users
---------------------------------------------------- */

export const createAdminAccount = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const actor = req.adminUser!;

    const parsed = createAdminAccountSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        message: parsed.error.issues[0]?.message ?? "Invalid request",
      });
      return;
    }

    const { email, firstName, lastName, role, password } = parsed.data;

    const exists = await prisma.adminUser.findUnique({
      where: { email },
      select: { id: true },
    });

    if (exists) {
      res.status(409).json({
        message: "An admin account with this email already exists",
      });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const admin = await prisma.adminUser.create({
      data: {
        email,
        firstName,
        lastName,
        role,
        passwordHash,
        status: "ACTIVE",
      },
      select: PUBLIC_FIELDS,
    });

    await recordAudit({
      actorId: actor.id,
      action: "CREATE",
      entityType: "AdminUser",
      entityId: admin.id,
      newValue: redactForAudit(admin as unknown as Record<string, unknown>),
      req,
    });

    res.status(201).json({ admin });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   PATCH /api/admin/users/:id/role
---------------------------------------------------- */

export const updateAdminRole = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const actor = req.adminUser!;
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ message: "Invalid admin id" });
      return;
    }

    const parsed = updateAdminRoleSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        message: parsed.error.issues[0]?.message ?? "Invalid request",
      });
      return;
    }

    const target = await prisma.adminUser.findUnique({
      where: { id },
      select: { id: true, role: true, email: true },
    });

    if (!target) {
      res.status(404).json({ message: "Admin account not found" });
      return;
    }

    if (!canManageTarget(actor, target)) {
      res.status(403).json({
        message: "You cannot change this account's role",
      });
      return;
    }

    // ADMIN accounts may only manage SUPPORT, and can only
    // (re)assign the SUPPORT role.
    if (actor.role === "ADMIN" && parsed.data.role !== "SUPPORT") {
      res.status(403).json({
        message: "Your admin account can only assign the support role",
      });
      return;
    }

    const admin = await prisma.adminUser.update({
      where: { id },
      data: { role: parsed.data.role },
      select: PUBLIC_FIELDS,
    });

    await recordAudit({
      actorId: actor.id,
      action: "UPDATE",
      entityType: "AdminUser",
      entityId: id,
      oldValue: { role: target.role },
      newValue: { role: admin.role },
      req,
    });

    res.json({ admin });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   PATCH /api/admin/users/:id/status
---------------------------------------------------- */

export const updateAdminStatus = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const actor = req.adminUser!;
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ message: "Invalid admin id" });
      return;
    }

    const parsed = updateAdminStatusSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        message: parsed.error.issues[0]?.message ?? "Invalid request",
      });
      return;
    }

    const target = await prisma.adminUser.findUnique({
      where: { id },
      select: { id: true, role: true, status: true },
    });

    if (!target) {
      res.status(404).json({ message: "Admin account not found" });
      return;
    }

    if (!canManageTarget(actor, target)) {
      res.status(403).json({
        message: "You cannot change this account's status",
      });
      return;
    }

    const admin = await prisma.adminUser.update({
      where: { id },
      data: { status: parsed.data.status },
      select: PUBLIC_FIELDS,
    });

    // Deactivating or suspending an account kills its sessions.
    if (parsed.data.status !== "ACTIVE") {
      await prisma.adminSession.updateMany({
        where: { adminUserId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    await recordAudit({
      actorId: actor.id,
      action: "UPDATE",
      entityType: "AdminUser",
      entityId: id,
      oldValue: { status: target.status },
      newValue: { status: admin.status },
      req,
    });

    res.json({ admin });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   DELETE /api/admin/users/:id
---------------------------------------------------- */

export const deleteAdminAccount = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const actor = req.adminUser!;
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ message: "Invalid admin id" });
      return;
    }

    const target = await prisma.adminUser.findUnique({
      where: { id },
      select: { id: true, role: true, email: true },
    });

    if (!target) {
      res.status(404).json({ message: "Admin account not found" });
      return;
    }

    if (!canManageTarget(actor, target)) {
      res.status(403).json({
        message: "You cannot delete this account",
      });
      return;
    }

    await prisma.adminUser.delete({ where: { id } });

    await recordAudit({
      actorId: actor.id,
      action: "DELETE",
      entityType: "AdminUser",
      entityId: id,
      oldValue: { email: target.email, role: target.role },
      req,
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};
