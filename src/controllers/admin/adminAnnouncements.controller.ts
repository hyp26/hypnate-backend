import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import prisma from "../../prisma/client";
import { AdminAuthRequest } from "../../middleware/adminAuth.middleware";
import { announcementSchema } from "../../schemas/admin.schemas";
import { recordAudit } from "../../services/adminAudit.service";

type AnnouncementInput = z.infer<typeof announcementSchema>;

type ParseBodyResult =
  | {
      ok: false;
      message: string;
      data?: never;
    }
  | {
      ok: true;
      data: AnnouncementInput;
      message?: never;
    };

const parseBody = (body: unknown): ParseBodyResult => {
  const parsed = announcementSchema.safeParse(body);

  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Invalid request",
    };
  }

  return {
    ok: true,
    data: parsed.data,
  };
};

const buildData = (data: AnnouncementInput) => ({
  title: data.title,
  content: data.content,
  type: data.type,
  status: data.status,
  priority: data.priority,
  targetAudience: data.targetAudience,
  startsAt: data.startsAt ? new Date(data.startsAt) : null,
  endsAt: data.endsAt ? new Date(data.endsAt) : null,
});

/* ----------------------------------------------------
   GET /api/admin/announcements
---------------------------------------------------- */

export const listAnnouncements = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const type = typeof req.query.type === "string" ? req.query.type : undefined;

    const where: Record<string, unknown> = {};

    if (
      status &&
      ["DRAFT", "PUBLISHED", "ARCHIVED"].includes(status.toUpperCase())
    ) {
      where.status = status.toUpperCase();
    }

    if (
      type &&
      ["GENERAL", "MAINTENANCE", "FEATURE", "SECURITY"].includes(type.toUpperCase())
    ) {
      where.type = type.toUpperCase();
    }

    const announcements = await prisma.announcement.findMany({
      where,
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    });

    res.json({ data: announcements });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   POST /api/admin/announcements
---------------------------------------------------- */

export const createAnnouncement = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const parsed = parseBody(req.body);

    if (!parsed.ok) {
      res.status(400).json({ message: parsed.message });
      return;
    }

    const announcement = await prisma.announcement.create({
      data: buildData(parsed.data),
    });

    await recordAudit({
      actorId: req.adminUser!.id,
      action: "CREATE",
      entityType: "Announcement",
      entityId: announcement.id,
      newValue: { title: announcement.title, status: announcement.status },
      req,
    });

    res.status(201).json({ announcement });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   PATCH /api/admin/announcements/:id
---------------------------------------------------- */

export const updateAnnouncement = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ message: "Invalid announcement id" });
      return;
    }

    const parsed = parseBody(req.body);

    if (!parsed.ok) {
      res.status(400).json({ message: parsed.message });
      return;
    }

    const existing = await prisma.announcement.findUnique({
      where: { id },
      select: { id: true, title: true, status: true },
    });

    if (!existing) {
      res.status(404).json({ message: "Announcement not found" });
      return;
    }

    const announcement = await prisma.announcement.update({
      where: { id },
      data: buildData(parsed.data),
    });

    await recordAudit({
      actorId: req.adminUser!.id,
      action: "UPDATE",
      entityType: "Announcement",
      entityId: id,
      oldValue: { title: existing.title, status: existing.status },
      newValue: { title: announcement.title, status: announcement.status },
      req,
    });

    res.json({ announcement });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   DELETE /api/admin/announcements/:id
---------------------------------------------------- */

export const deleteAnnouncement = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ message: "Invalid announcement id" });
      return;
    }

    const existing = await prisma.announcement.findUnique({
      where: { id },
      select: { id: true, title: true },
    });

    if (!existing) {
      res.status(404).json({ message: "Announcement not found" });
      return;
    }

    await prisma.announcement.delete({ where: { id } });

    await recordAudit({
      actorId: req.adminUser!.id,
      action: "DELETE",
      entityType: "Announcement",
      entityId: id,
      oldValue: { title: existing.title },
      req,
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};
