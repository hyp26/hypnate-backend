import { Request, Response, NextFunction } from "express";
import prisma from "../../prisma/client";
import { AdminAuthRequest } from "../../middleware/adminAuth.middleware";
import { contentPageSchema } from "../../schemas/admin.schemas";
import { recordAudit } from "../../services/adminAudit.service";

const parseId = (value: string): number | null => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const parseBody = (body: unknown) => {
  const parsed = contentPageSchema.safeParse(body);

  if (!parsed.success) {
    return {
      ok: false as const,
      message: parsed.error.issues[0]?.message ?? "Invalid request",
    };
  }

  return { ok: true as const, data: parsed.data };
};

/* ----------------------------------------------------
   GET /api/admin/content
---------------------------------------------------- */

export const listContentPages = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const status =
      typeof req.query.status === "string" &&
      ["DRAFT", "PUBLISHED", "ARCHIVED"].includes(req.query.status.toUpperCase())
        ? (req.query.status.toUpperCase() as "DRAFT" | "PUBLISHED" | "ARCHIVED")
        : undefined;

    const pages = await prisma.contentPage.findMany({
      where: status ? { status } : undefined,
      orderBy: { updatedAt: "desc" },
    });

    res.json({ data: pages });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   POST /api/admin/content
---------------------------------------------------- */

export const createContentPage = async (
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

    const existing = await prisma.contentPage.findUnique({
      where: { slug: parsed.data.slug },
      select: { id: true },
    });

    if (existing) {
      res.status(409).json({ message: "A page with this slug already exists" });
      return;
    }

    const page = await prisma.contentPage.create({
      data: {
        ...parsed.data,
        createdByAdminId: req.adminUser!.id,
      },
    });

    await recordAudit({
      actorId: req.adminUser!.id,
      action: "CREATE",
      entityType: "ContentPage",
      entityId: page.id,
      newValue: { slug: page.slug, title: page.title },
      req,
    });

    res.status(201).json({ page });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   PATCH /api/admin/content/:id
---------------------------------------------------- */

export const updateContentPage = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const id = parseId(req.params.id);

    if (!id) {
      res.status(400).json({ message: "Invalid page id" });
      return;
    }

    const parsed = parseBody(req.body);

    if (!parsed.ok) {
      res.status(400).json({ message: parsed.message });
      return;
    }

    const existing = await prisma.contentPage.findUnique({
      where: { id },
      select: { id: true, slug: true, title: true, status: true },
    });

    if (!existing) {
      res.status(404).json({ message: "Content page not found" });
      return;
    }

    if (parsed.data.slug !== existing.slug) {
      const slugTaken = await prisma.contentPage.findUnique({
        where: { slug: parsed.data.slug },
        select: { id: true },
      });

      if (slugTaken) {
        res
          .status(409)
          .json({ message: "A page with this slug already exists" });
        return;
      }
    }

    const page = await prisma.contentPage.update({
      where: { id },
      data: parsed.data,
    });

    await recordAudit({
      actorId: req.adminUser!.id,
      action: "UPDATE",
      entityType: "ContentPage",
      entityId: id,
      oldValue: { slug: existing.slug, title: existing.title, status: existing.status },
      newValue: { slug: page.slug, title: page.title, status: page.status },
      req,
    });

    res.json({ page });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   DELETE /api/admin/content/:id
---------------------------------------------------- */

export const deleteContentPage = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const id = parseId(req.params.id);

    if (!id) {
      res.status(400).json({ message: "Invalid page id" });
      return;
    }

    const existing = await prisma.contentPage.findUnique({
      where: { id },
      select: { id: true, slug: true },
    });

    if (!existing) {
      res.status(404).json({ message: "Content page not found" });
      return;
    }

    await prisma.contentPage.delete({ where: { id } });

    await recordAudit({
      actorId: req.adminUser!.id,
      action: "DELETE",
      entityType: "ContentPage",
      entityId: id,
      oldValue: { slug: existing.slug },
      req,
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};
