import { Request, Response, NextFunction } from "express";
import prisma from "../../prisma/client";
import { AdminAuthRequest } from "../../middleware/adminAuth.middleware";
import { listAuditLogsSchema } from "../../schemas/admin.schemas";

/* ----------------------------------------------------
   GET /api/admin/audit-logs
---------------------------------------------------- */

export const listAuditLogs = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const parsed = listAuditLogsSchema.safeParse(req);

    if (!parsed.success) {
      res.status(400).json({
        message: parsed.error.issues[0]?.message ?? "Invalid request",
      });
      return;
    }

    const {
      page,
      limit,
      action,
      adminUserId,
      entityType,
      search,
    } = parsed.data.query;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};

    if (action) {
      where.action = action;
    }

    if (adminUserId) {
      where.adminUserId = adminUserId;
    }

    if (entityType) {
      where.entityType = entityType;
    }

    if (search) {
      where.OR = [
        { entityId: { contains: search, mode: "insensitive" } },
        { entityType: { contains: search, mode: "insensitive" } },
        { adminUser: { email: { contains: search, mode: "insensitive" } } },
      ];
    }

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        select: {
          id: true,
          action: true,
          entityType: true,
          entityId: true,
          oldValue: true,
          newValue: true,
          ipAddress: true,
          userAgent: true,
          createdAt: true,
          adminUser: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
              role: true,
            },
          },
        },
      }),
      prisma.auditLog.count({ where }),
    ]);

    const data = logs.map((log) => ({
      id: log.id,
      adminUserId: log.adminUser?.id,
      adminUser: log.adminUser
        ? {
            id: log.adminUser.id,
            email: log.adminUser.email,
            firstName: log.adminUser.firstName,
            lastName: log.adminUser.lastName,
            role: log.adminUser.role,
            status: "ACTIVE",
            createdAt: "",
          }
        : undefined,
      action: log.action,
      entityType: log.entityType ?? undefined,
      entityId: log.entityId ?? "",
      oldValue: log.oldValue ?? null,
      newValue: log.newValue ?? null,
      ipAddress: log.ipAddress ?? undefined,
      userAgent: log.userAgent ?? undefined,
      createdAt: log.createdAt.toISOString(),
    }));

    res.json({
      data,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    next(err);
  }
};
