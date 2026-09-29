import { Request, Response, NextFunction } from "express";
import prisma from "../../prisma/client";
import { AdminAuthRequest } from "../../middleware/adminAuth.middleware";
import {
  createTicketMessageSchema,
  createTicketSchema,
  listTicketsSchema,
  updateTicketSchema,
} from "../../schemas/admin.schemas";
import { recordAudit } from "../../services/adminAudit.service";

/* ----------------------------------------------------
   HELPERS
---------------------------------------------------- */

const TICKET_INCLUDE = {
  assignedTo: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      role: true,
    },
  },
  messages: {
    orderBy: { createdAt: "asc" as const },
    select: {
      id: true,
      body: true,
      isInternal: true,
      createdAt: true,
      authorAdmin: {
        select: { id: true, firstName: true, lastName: true },
      },
    },
  },
} as const;

const serializeTicket = (ticket: {
  id: number;
  ticketNumber: string;
  subject: string;
  description: string | null;
  status: string;
  priority: string;
  category: string | null;
  sellerId: number | null;
  customerId: number | null;
  assignedToAdminId: number | null;
  assignedTo: {
    id: number;
    firstName: string;
    lastName: string;
    email: string;
    role: string;
  } | null;
  tags: string[];
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  messages: {
    id: number;
    body: string;
    isInternal: boolean;
    createdAt: Date;
    authorAdmin: { id: number; firstName: string; lastName: string } | null;
  }[];
}) => ({
  id: ticket.ticketNumber,
  numericId: ticket.id,
  ticketNumber: ticket.ticketNumber,
  subject: ticket.subject,
  description: ticket.description ?? undefined,
  status: ticket.status,
  priority: ticket.priority,
  category: ticket.category ?? undefined,
  sellerId: ticket.sellerId ?? undefined,
  customerId: ticket.customerId ?? undefined,
  assignedToId: ticket.assignedToAdminId ?? undefined,
  assignedTo: ticket.assignedTo
    ? {
        id: ticket.assignedTo.id,
        firstName: ticket.assignedTo.firstName,
        lastName: ticket.assignedTo.lastName,
        email: ticket.assignedTo.email,
        role: ticket.assignedTo.role,
      }
    : undefined,
  tags: ticket.tags,
  messages: ticket.messages.map((message) => ({
    id: String(message.id),
    body: message.body,
    isInternal: message.isInternal,
    author: message.authorAdmin
      ? `${message.authorAdmin.firstName} ${message.authorAdmin.lastName}`.trim()
      : "System",
    createdAt: message.createdAt.toISOString(),
  })),
  resolvedAt: ticket.resolvedAt?.toISOString() ?? undefined,
  createdAt: ticket.createdAt.toISOString(),
  updatedAt: ticket.updatedAt.toISOString(),
});

const generateTicketNumber = async (): Promise<string> => {
  const year = new Date().getFullYear();

  const count = await prisma.supportTicket.count();

  return `TKT-${year}-${String(count + 1).padStart(6, "0")}`;
};

/* ----------------------------------------------------
   GET /api/admin/tickets
---------------------------------------------------- */

export const listTickets = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const parsed = listTicketsSchema.safeParse(req);

    if (!parsed.success) {
      res.status(400).json({
        message: parsed.error.issues[0]?.message ?? "Invalid request",
      });
      return;
    }

    const {
      page,
      limit,
      search,
      status,
      priority,
      assignedToAdminId,
    } = parsed.data.query;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};

    if (status) {
      where.status = status;
    }

    if (priority) {
      where.priority = priority;
    }

    if (assignedToAdminId) {
      where.assignedToAdminId = assignedToAdminId;
    }

    if (search) {
      where.OR = [
        { ticketNumber: { contains: search, mode: "insensitive" } },
        { subject: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
      ];
    }

    const [tickets, total, statusCounts] = await Promise.all([
      prisma.supportTicket.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: { ...TICKET_INCLUDE, messages: { take: 0, select: { id: true } } },
      }),
      prisma.supportTicket.count({ where }),
      prisma.supportTicket.groupBy({
        by: ["status"],
        _count: { id: true },
      }),
    ]);

    const statusBreakdown: Record<string, number> = {};
    for (const row of statusCounts) {
      statusBreakdown[row.status] = row._count.id;
    }

    res.json({
      data: tickets.map((ticket) =>
        serializeTicket({ ...ticket, messages: [] })
      ),
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      statusBreakdown,
    });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   GET /api/admin/tickets/:id
---------------------------------------------------- */

export const getTicket = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const identifier = req.params.id;

    const ticket = await prisma.supportTicket.findFirst({
      where: {
        OR: [
          { ticketNumber: identifier },
          { id: Number(identifier) || -1 },
        ],
      },
      include: TICKET_INCLUDE,
    });

    if (!ticket) {
      res.status(404).json({ message: "Ticket not found" });
      return;
    }

    res.json({ ticket: serializeTicket(ticket) });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   POST /api/admin/tickets
---------------------------------------------------- */

export const createTicket = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const parsed = createTicketSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        message: parsed.error.issues[0]?.message ?? "Invalid request",
      });
      return;
    }

    const ticketNumber = await generateTicketNumber();

    const ticket = await prisma.supportTicket.create({
      data: {
        ticketNumber,
        subject: parsed.data.subject,
        description: parsed.data.description ?? null,
        priority: parsed.data.priority,
        category: parsed.data.category ?? null,
        sellerId: parsed.data.sellerId ?? null,
        customerId: parsed.data.customerId ?? null,
        tags: parsed.data.tags,
      },
      include: TICKET_INCLUDE,
    });

    await recordAudit({
      actorId: req.adminUser!.id,
      action: "CREATE",
      entityType: "SupportTicket",
      entityId: ticket.id,
      newValue: { ticketNumber, subject: ticket.subject },
      req,
    });

    res.status(201).json({ ticket: serializeTicket(ticket) });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   PATCH /api/admin/tickets/:id
---------------------------------------------------- */

export const updateTicket = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const identifier = req.params.id;

    const parsed = updateTicketSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        message: parsed.error.issues[0]?.message ?? "Invalid request",
      });
      return;
    }

    const existing = await prisma.supportTicket.findFirst({
      where: {
        OR: [
          { ticketNumber: identifier },
          { id: Number(identifier) || -1 },
        ],
      },
      select: {
        id: true,
        ticketNumber: true,
        status: true,
        priority: true,
        assignedToAdminId: true,
      },
    });

    if (!existing) {
      res.status(404).json({ message: "Ticket not found" });
      return;
    }

    // SUPPORT staff may only touch tickets assigned to them.
    if (req.adminUser!.role === "SUPPORT") {
      if (existing.assignedToAdminId !== req.adminUser!.id) {
        res.status(403).json({
          message: "This ticket is not assigned to you",
        });
        return;
      }

      if (parsed.data.assignedToAdminId !== undefined) {
        res.status(403).json({
          message: "Support accounts cannot reassign tickets",
        });
        return;
      }
    }

    if (parsed.data.assignedToAdminId) {
      const assignee = await prisma.adminUser.findUnique({
        where: { id: parsed.data.assignedToAdminId },
        select: { id: true, status: true },
      });

      if (!assignee || assignee.status !== "ACTIVE") {
        res.status(400).json({ message: "Assignee is not an active admin" });
        return;
      }
    }

    const data: Record<string, unknown> = {};

    if (parsed.data.subject !== undefined) {
      data.subject = parsed.data.subject;
    }

    if (parsed.data.description !== undefined) {
      data.description = parsed.data.description;
    }

    if (parsed.data.status !== undefined) {
      data.status = parsed.data.status;
      data.resolvedAt =
        parsed.data.status === "RESOLVED" ? new Date() : null;
    }

    if (parsed.data.priority !== undefined) {
      data.priority = parsed.data.priority;
    }

    if (parsed.data.category !== undefined) {
      data.category = parsed.data.category;
    }

    if (parsed.data.tags !== undefined) {
      data.tags = parsed.data.tags;
    }

    if (parsed.data.assignedToAdminId !== undefined) {
      data.assignedToAdminId = parsed.data.assignedToAdminId;
    }

    const ticket = await prisma.supportTicket.update({
      where: { id: existing.id },
      data,
      include: TICKET_INCLUDE,
    });

    await recordAudit({
      actorId: req.adminUser!.id,
      action: "UPDATE",
      entityType: "SupportTicket",
      entityId: existing.id,
      oldValue: {
        status: existing.status,
        priority: existing.priority,
        assignedToAdminId: existing.assignedToAdminId,
      },
      newValue: {
        status: ticket.status,
        priority: ticket.priority,
        assignedToAdminId: ticket.assignedToAdminId,
      },
      req,
    });

    res.json({ ticket: serializeTicket(ticket) });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   POST /api/admin/tickets/:id/messages
---------------------------------------------------- */

export const addTicketMessage = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const identifier = req.params.id;

    const parsed = createTicketMessageSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        message: parsed.error.issues[0]?.message ?? "Invalid request",
      });
      return;
    }

    const ticket = await prisma.supportTicket.findFirst({
      where: {
        OR: [
          { ticketNumber: identifier },
          { id: Number(identifier) || -1 },
        ],
      },
      select: { id: true, ticketNumber: true, assignedToAdminId: true },
    });

    if (!ticket) {
      res.status(404).json({ message: "Ticket not found" });
      return;
    }

    if (
      req.adminUser!.role === "SUPPORT" &&
      ticket.assignedToAdminId !== req.adminUser!.id
    ) {
      res.status(403).json({
        message: "This ticket is not assigned to you",
      });
      return;
    }

    const message = await prisma.ticketMessage.create({
      data: {
        ticketId: ticket.id,
        authorAdminId: req.adminUser!.id,
        body: parsed.data.body,
        isInternal: parsed.data.isInternal,
      },
    });

    await prisma.supportTicket.update({
      where: { id: ticket.id },
      data: { updatedAt: new Date() },
    });

    await recordAudit({
      actorId: req.adminUser!.id,
      action: "UPDATE",
      entityType: "TicketMessage",
      entityId: message.id,
      newValue: { ticketNumber: ticket.ticketNumber },
      req,
    });

    res.status(201).json({
      message: {
        id: String(message.id),
        body: message.body,
        isInternal: message.isInternal,
        author: `${req.adminUser!.firstName} ${req.adminUser!.lastName}`.trim(),
        createdAt: message.createdAt.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   DELETE /api/admin/tickets/:id
---------------------------------------------------- */

export const deleteTicket = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const identifier = req.params.id;

    const ticket = await prisma.supportTicket.findFirst({
      where: {
        OR: [
          { ticketNumber: identifier },
          { id: Number(identifier) || -1 },
        ],
      },
      select: { id: true, ticketNumber: true },
    });

    if (!ticket) {
      res.status(404).json({ message: "Ticket not found" });
      return;
    }

    await prisma.supportTicket.delete({ where: { id: ticket.id } });

    await recordAudit({
      actorId: req.adminUser!.id,
      action: "DELETE",
      entityType: "SupportTicket",
      entityId: ticket.id,
      oldValue: { ticketNumber: ticket.ticketNumber },
      req,
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};
