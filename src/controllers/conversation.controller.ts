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
// GET /api/conversations/stats
// ─────────────────────────────────────────────

export const getConversationStats = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
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
// GET /api/conversations
// ─────────────────────────────────────────────

export const getConversations = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = await resolveSellerId(req);
    if (!sellerId) return res.status(401).json({ message: "Unauthorized" });

    const platform = req.query.platform as string | undefined;
    const status = req.query.status as string | undefined;
    const search =
      typeof req.query.search === "string" ? req.query.search : "";

    const conversations = await prisma.conversation.findMany({
      where: {
        sellerId,
        ...(platform &&
          platform !== "all" && {
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

// ─────────────────────────────────────────────
// GET /api/conversations/:id
// ─────────────────────────────────────────────

export const getConversationById = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = await resolveSellerId(req);
    if (!sellerId) return res.status(401).json({ message: "Unauthorized" });

    const id = Number(req.params.id);
    if (Number.isNaN(id))
      return res.status(400).json({ message: "Invalid ID" });

    const conversation = await prisma.conversation.findFirst({
      where: { id, sellerId },
    });

    if (!conversation)
      return res.status(404).json({ message: "Conversation not found" });

    res.json(conversation);
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// GET /api/conversations/:id/messages
// ─────────────────────────────────────────────

export const getMessages = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = await resolveSellerId(req);
    if (!sellerId) return res.status(401).json({ message: "Unauthorized" });

    const id = Number(req.params.id);
    if (Number.isNaN(id))
      return res.status(400).json({ message: "Invalid ID" });

    const conversation = await prisma.conversation.findFirst({
      where: { id, sellerId },
    });
    if (!conversation)
      return res.status(404).json({ message: "Conversation not found" });

    const messages = await prisma.message.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: "asc" },
    });

    // Mark customer messages as read + reset unread count atomically
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
// POST /api/conversations/:id/messages
// ─────────────────────────────────────────────

export const sendMessage = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = await resolveSellerId(req);
    if (!sellerId) return res.status(401).json({ message: "Unauthorized" });

    const id = Number(req.params.id);
    if (Number.isNaN(id))
      return res.status(400).json({ message: "Invalid ID" });

    const conversation = await prisma.conversation.findFirst({
      where: { id, sellerId },
    });
    if (!conversation)
      return res.status(404).json({ message: "Conversation not found" });

    const { text, type = "text", mediaUrl, metadata } = req.body;
    if (!text?.trim())
      return res.status(400).json({ message: "Message text is required" });

    const [message] = await prisma.$transaction([
      prisma.message.create({
        data: {
          conversationId: id,
          sender: "SELLER",
          text: text.trim(),
          type,
          mediaUrl: mediaUrl ?? null,
          metadata: metadata ?? undefined,
          isRead: true,
        },
      }),
      prisma.conversation.update({
        where: { id },
        data: {
          lastMessage: text.trim(),
          lastMessageAt: new Date(),
        },
      }),
    ]);

    res.status(201).json(message);
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// PATCH /api/conversations/:id/status
// ─────────────────────────────────────────────

export const updateConversationStatus = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = await resolveSellerId(req);
    if (!sellerId) return res.status(401).json({ message: "Unauthorized" });

    const id = Number(req.params.id);
    if (Number.isNaN(id))
      return res.status(400).json({ message: "Invalid ID" });

    const { status } = req.body;
    if (!["OPEN", "RESOLVED", "PENDING"].includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const conversation = await prisma.conversation.findFirst({
      where: { id, sellerId },
    });
    if (!conversation)
      return res.status(404).json({ message: "Conversation not found" });

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
// POST /api/conversations/webhook/:platform
// Receives incoming messages from platform webhooks
// Register these URLs in each platform's developer dashboard:
//   WhatsApp:  POST /api/conversations/webhook/whatsapp
//   Instagram: POST /api/conversations/webhook/instagram
//   Facebook:  POST /api/conversations/webhook/facebook
//   Telegram:  POST /api/conversations/webhook/telegram
//
// Set in your .env:
//   WEBHOOK_VERIFY_TOKEN=your_secret_token
//   DEFAULT_SELLER_ID=1  (or per-platform: WHATSAPP_SELLER_ID=1)
// ─────────────────────────────────────────────

export const receiveWebhook = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const platform = req.params.platform.toUpperCase();
    const body = req.body;

    let externalId: string | undefined;
    let customerName: string;
    let messageText: string;
    let customerPhone: string | undefined;

    if (platform === "WHATSAPP") {
      const entry = body?.entry?.[0]?.changes?.[0]?.value;
      const msg = entry?.messages?.[0];
      if (!msg) return res.sendStatus(200);
      externalId = msg.from;
      customerPhone = msg.from;
      customerName =
        entry?.contacts?.[0]?.profile?.name ?? msg.from ?? "WhatsApp User";
      messageText = msg.text?.body ?? "[media message]";
    } else if (platform === "TELEGRAM") {
      const msg = body?.message;
      if (!msg) return res.sendStatus(200);
      externalId = String(msg.from?.id);
      customerName =
        [msg.from?.first_name, msg.from?.last_name]
          .filter(Boolean)
          .join(" ") || "Telegram User";
      messageText = msg.text ?? "[media message]";
    } else if (platform === "INSTAGRAM" || platform === "FACEBOOK") {
      const entry = body?.entry?.[0]?.messaging?.[0];
      if (!entry) return res.sendStatus(200);
      externalId = entry.sender?.id;
      customerName = `${platform.charAt(0)}${platform.slice(1).toLowerCase()} User`;
      messageText = entry.message?.text ?? "[media message]";
    } else {
      return res.status(400).json({ message: "Unknown platform" });
    }

    const envKey = `${platform}_SELLER_ID`;
    const sellerIdRaw =
      process.env[envKey] ?? process.env.DEFAULT_SELLER_ID ?? "1";
    const sellerId = Number(sellerIdRaw);

    let conversation = await prisma.conversation.findFirst({
      where: { sellerId, platform: platform as any, externalId },
    });

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          sellerId,
          platform: platform as any,
          customerName,
          customerPhone: customerPhone ?? null,
          externalId,
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

// ─────────────────────────────────────────────
// GET /api/conversations/webhook/:platform
// Verification handshake required by WhatsApp & Facebook
// ─────────────────────────────────────────────

export const verifyWebhook = (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log(`Webhook verified for platform ✅`);
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
};