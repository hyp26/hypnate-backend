import { Request, Response, NextFunction } from "express";
import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";

// ─────────────────────────────────────────────
// HELPER
// ─────────────────────────────────────────────
const resolveSellerId = async (req: Request): Promise<number | undefined> => {
  const authReq = req as AuthRequest;

  if (authReq.user?.sellerId) return authReq.user.sellerId;

  if (authReq.user?.id) {
    const user = await prisma.user.findUnique({
      where: { id: authReq.user.id },
      select: { sellerId: true },
    });
    return user?.sellerId ?? undefined;
  }

  return undefined;
};

// ─────────────────────────────────────────────
// GET STATS
// ─────────────────────────────────────────────
export const getConversationStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await resolveSellerId(req);
    if (!sellerId) return res.status(401).json({ message: "Unauthorized" });

    const [total, open, pending, resolved, unreadAgg] = await Promise.all([
      prisma.conversation.count({ where: { sellerId } }),
      prisma.conversation.count({ where: { sellerId, status: "OPEN" } }),
      prisma.conversation.count({ where: { sellerId, status: "PENDING" } }),
      prisma.conversation.count({ where: { sellerId, status: "RESOLVED" } }),
      prisma.conversation.aggregate({
        where: { sellerId },
        _sum: { unreadCount: true },
      }),
    ]);

    res.json({
      total,
      open,
      pending,
      resolved,
      totalUnread: unreadAgg._sum.unreadCount ?? 0,
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// GET CONVERSATIONS
// ─────────────────────────────────────────────
export const getConversations = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await resolveSellerId(req);
    if (!sellerId) return res.status(401).json({ message: "Unauthorized" });

    const platform = req.query.platform as string | undefined;
    const status = req.query.status as string | undefined;
    const search = typeof req.query.search === "string" ? req.query.search : "";

    const conversations = await prisma.conversation.findMany({
      where: {
        sellerId,
        ...(platform && platform !== "all" && {
          platform: platform.toUpperCase() as any,
        }),
        ...(status && { status: status.toUpperCase() as any }),
        ...(search && {
          OR: [
            { customerName: { contains: search, mode: "insensitive" } },
            { lastMessage: { contains: search, mode: "insensitive" } },
            { customerPhone: { contains: search, mode: "insensitive" } },
          ],
        }),
      },
      orderBy: { lastMessageAt: "desc" },
    });

    res.json(conversations);
  } catch (err) {
    next(err);
  }
};

export const getConversationById = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = await resolveSellerId(req);
    if (!sellerId) return res.status(401).json({ message: "Unauthorized" });

    const id = Number(req.params.id);

    const conversation = await prisma.conversation.findFirst({
      where: { id, sellerId },
    });

    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    res.json(conversation);
  } catch (err) {
    next(err);
  }
};

export const updateConversationStatus = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = await resolveSellerId(req);
    if (!sellerId) return res.status(401).json({ message: "Unauthorized" });

    const id = Number(req.params.id);
    const { status } = req.body;

    if (!["OPEN", "RESOLVED", "PENDING"].includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const updated = await prisma.conversation.update({
      where: { id },
      data: { status },
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// GET MESSAGES
// ─────────────────────────────────────────────
export const getMessages = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await resolveSellerId(req);
    if (!sellerId) return res.status(401).json({ message: "Unauthorized" });

    const id = Number(req.params.id);

    const messages = await prisma.message.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: "asc" },
    });

    await prisma.$transaction([
      prisma.message.updateMany({
        where: { conversationId: id, sender: "CUSTOMER", isRead: false },
        data: { isRead: true },
      }),
      prisma.conversation.update({
        where: { id },
        data: { unreadCount: 0 },
      }),
    ]);

    res.json(messages);
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// SEND MESSAGE
// ─────────────────────────────────────────────
export const sendMessage = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sellerId = await resolveSellerId(req);
    if (!sellerId) return res.status(401).json({ message: "Unauthorized" });

    const id = Number(req.params.id);

    const { text, type = "text", mediaUrl, metadata } = req.body;

    const message = await prisma.message.create({
      data: {
        conversationId: id,
        sender: "SELLER",
        direction: "OUTBOUND", // ✅ FIXED
        text: text.trim(),
        type,
        mediaUrl: mediaUrl ?? null,
        metadata: metadata ?? undefined,
        isRead: true,
      },
    });

    await prisma.conversation.update({
      where: { id },
      data: {
        lastMessage: text.trim(),
        lastMessageAt: new Date(),
      },
    });

    res.json(message);
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// WEBHOOK (CORE)
// ─────────────────────────────────────────────

export const verifyWebhook = (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  } else {
    return res.sendStatus(403);
  }
};

export const receiveWebhook = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const platform = req.params.platform.toUpperCase();
    const body = req.body;

    let externalUserId: string | undefined;
    let customerName = "User";
    let messageText = "[message]";
    let customerPhone: string | undefined;

    if (platform === "TELEGRAM") {
      const msg = body?.message;
      if (!msg) return res.sendStatus(200);

      externalUserId = String(msg.from?.id);
      customerName = msg.from?.first_name || "Telegram User";
      messageText = msg.text || "[media]";
    }

    if (!externalUserId) return res.sendStatus(200); // ✅ FIX

    const sellerId = Number(process.env.DEFAULT_SELLER_ID || "1");

    let conversation = await prisma.conversation.findUnique({
      where: {
        sellerId_platform_externalUserId: {
          sellerId,
          platform: platform as any,
          externalUserId,
        },
      },
    });

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          sellerId,
          platform: platform as any,
          customerName,
          customerPhone: customerPhone ?? null,
          externalUserId,
          status: "OPEN",
          lastMessage: messageText,
          lastMessageAt: new Date(),
          unreadCount: 1,
        },
      });
    } else {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastMessage: messageText,
          lastMessageAt: new Date(),
          unreadCount: { increment: 1 },
          status: "OPEN",
        },
      });
    }

    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        sender: "CUSTOMER",
        direction: "INBOUND", // ✅ FIXED
        text: messageText,
        type: "text",
        isRead: false,
      },
    });

    res.sendStatus(200);
  } catch (err) {
    next(err);
  }
};