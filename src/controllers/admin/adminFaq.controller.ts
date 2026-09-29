import { Request, Response, NextFunction } from "express";
import prisma from "../../prisma/client";
import { AdminAuthRequest } from "../../middleware/adminAuth.middleware";
import { faqSchema } from "../../schemas/admin.schemas";
import { recordAudit } from "../../services/adminAudit.service";

const parseId = (value: string): number | null => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const parseBody = (body: unknown) => {
  const parsed = faqSchema.safeParse(body);

  if (!parsed.success) {
    return {
      ok: false as const,
      message: parsed.error.issues[0]?.message ?? "Invalid request",
    };
  }

  return { ok: true as const, data: parsed.data };
};

/* ----------------------------------------------------
   GET /api/admin/faq
---------------------------------------------------- */

export const listFaqs = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const category =
      typeof req.query.category === "string" && req.query.category.trim()
        ? req.query.category.trim()
        : undefined;

    const faqs = await prisma.fAQItem.findMany({
      where: category ? { category } : undefined,
      orderBy: [{ order: "asc" }, { createdAt: "desc" }],
    });

    res.json({ data: faqs });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   POST /api/admin/faq
---------------------------------------------------- */

export const createFaq = async (
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

    const faq = await prisma.fAQItem.create({
      data: parsed.data,
    });

    await recordAudit({
      actorId: req.adminUser!.id,
      action: "CREATE",
      entityType: "FAQItem",
      entityId: faq.id,
      newValue: { question: faq.question },
      req,
    });

    res.status(201).json({ faq });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   PATCH /api/admin/faq/:id
---------------------------------------------------- */

export const updateFaq = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const id = parseId(req.params.id);

    if (!id) {
      res.status(400).json({ message: "Invalid FAQ id" });
      return;
    }

    const parsed = parseBody(req.body);

    if (!parsed.ok) {
      res.status(400).json({ message: parsed.message });
      return;
    }

    const existing = await prisma.fAQItem.findUnique({
      where: { id },
      select: { id: true, question: true, isPublished: true },
    });

    if (!existing) {
      res.status(404).json({ message: "FAQ item not found" });
      return;
    }

    const faq = await prisma.fAQItem.update({
      where: { id },
      data: parsed.data,
    });

    await recordAudit({
      actorId: req.adminUser!.id,
      action: "UPDATE",
      entityType: "FAQItem",
      entityId: id,
      oldValue: {
        question: existing.question,
        isPublished: existing.isPublished,
      },
      newValue: { question: faq.question, isPublished: faq.isPublished },
      req,
    });

    res.json({ faq });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   DELETE /api/admin/faq/:id
---------------------------------------------------- */

export const deleteFaq = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const id = parseId(req.params.id);

    if (!id) {
      res.status(400).json({ message: "Invalid FAQ id" });
      return;
    }

    const existing = await prisma.fAQItem.findUnique({
      where: { id },
      select: { id: true, question: true },
    });

    if (!existing) {
      res.status(404).json({ message: "FAQ item not found" });
      return;
    }

    await prisma.fAQItem.delete({ where: { id } });

    await recordAudit({
      actorId: req.adminUser!.id,
      action: "DELETE",
      entityType: "FAQItem",
      entityId: id,
      oldValue: { question: existing.question },
      req,
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};
