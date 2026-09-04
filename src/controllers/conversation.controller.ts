import { Request, Response, NextFunction } from "express";
import prisma from "../prisma/client";
import { getSellerId } from "../services/seller.service";
import { sendMessage as sendPlatformMessage } from "../services/messaging/messaging.service";
import { logger } from "../utils/logger";

// ─────────────────────────────────────────────
// GET STATS
// ─────────────────────────────────────────────
export const getConversationStats = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = await getSellerId(req);

    if (!sellerId) {
      return res.status(401).json({
        message: "Unauthorized",
      });
    }

    const [total, open, pending, resolved, unreadAgg] =
      await Promise.all([
        prisma.conversation.count({
          where: { sellerId },
        }),

        prisma.conversation.count({
          where: {
            sellerId,
            status: "OPEN",
          },
        }),

        prisma.conversation.count({
          where: {
            sellerId,
            status: "PENDING",
          },
        }),

        prisma.conversation.count({
          where: {
            sellerId,
            status: "RESOLVED",
          },
        }),

        prisma.conversation.aggregate({
          where: { sellerId },
          _sum: {
            unreadCount: true,
          },
        }),
      ]);

    return res.json({
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
export const getConversations = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = await getSellerId(req);

    if (!sellerId) {
      return res.status(401).json({
        message: "Unauthorized",
      });
    }

    const platform = req.query.platform as string | undefined;
    const status = req.query.status as string | undefined;

    const search =
      typeof req.query.search === "string"
        ? req.query.search
        : "";

    const conversations =
      await prisma.conversation.findMany({
        where: {
          sellerId,

          ...(platform &&
            platform !== "all" && {
              platform: platform.toUpperCase() as any,
            }),

          ...(status && {
            status: status.toUpperCase() as any,
          }),

          ...(search && {
            OR: [
              {
                customerName: {
                  contains: search,
                  mode: "insensitive",
                },
              },
              {
                lastMessage: {
                  contains: search,
                  mode: "insensitive",
                },
              },
              {
                customerPhone: {
                  contains: search,
                  mode: "insensitive",
                },
              },
            ],
          }),
        },

        orderBy: {
          lastMessageAt: "desc",
        },
      });

    return res.json(conversations);
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// GET CONVERSATION BY ID
// ─────────────────────────────────────────────
export const getConversationById = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = await getSellerId(req);

    if (!sellerId) {
      return res.status(401).json({
        message: "Unauthorized",
      });
    }

    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        message: "Invalid conversation id",
      });
    }

    // IMPORTANT:
    // Conversation lookup is always scoped to the authenticated seller.
    const conversation =
      await prisma.conversation.findFirst({
        where: {
          id,
          sellerId,
        },
      });

    if (!conversation) {
      return res.status(404).json({
        message: "Conversation not found",
      });
    }

    return res.json(conversation);
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// UPDATE STATUS
// ─────────────────────────────────────────────
export const updateConversationStatus = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = await getSellerId(req);

    if (!sellerId) {
      return res.status(401).json({
        message: "Unauthorized",
      });
    }

    const id = Number(req.params.id);
    const { status } = req.body;

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        message: "Invalid conversation id",
      });
    }

    if (!["OPEN", "RESOLVED", "PENDING"].includes(status)) {
      return res.status(400).json({
        message: "Invalid status",
      });
    }

    // IMPORTANT:
    // Verify ownership before changing anything.
    const existing =
      await prisma.conversation.findFirst({
        where: {
          id,
          sellerId,
        },
      });

    if (!existing) {
      return res.status(404).json({
        message: "Conversation not found",
      });
    }

    // Keep sellerId in the update condition as an additional
    // tenant-isolation guarantee.
    const updateResult =
      await prisma.conversation.updateMany({
        where: {
          id,
          sellerId,
        },

        data: {
          status,
        },
      });

    if (updateResult.count !== 1) {
      return res.status(404).json({
        message: "Conversation not found",
      });
    }

    const updated =
      await prisma.conversation.findFirst({
        where: {
          id,
          sellerId,
        },
      });

    if (!updated) {
      return res.status(404).json({
        message: "Conversation not found",
      });
    }

    const io = req.app.get("io");

    // IMPORTANT:
    // Never broadcast tenant data globally.
    // Only notify sockets belonging to this seller.
    if (io) {
      io.to(`seller_${sellerId}`).emit(
        "conversation_updated",
        {
          conversationId: updated.id,
          conversation: updated,
        }
      );
    }

    return res.json(updated);
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// GET MESSAGES
// ─────────────────────────────────────────────
export const getMessages = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = await getSellerId(req);

    if (!sellerId) {
      return res.status(401).json({
        message: "Unauthorized",
      });
    }

    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        message: "Invalid conversation id",
      });
    }

    // CRITICAL SECURITY CHECK:
    // Never query messages using conversationId alone.
    // First establish that this conversation belongs to
    // the authenticated seller.
    const conversation =
      await prisma.conversation.findFirst({
        where: {
          id,
          sellerId,
        },
      });

    if (!conversation) {
      return res.status(404).json({
        message: "Conversation not found",
      });
    }

    const messages = await prisma.message.findMany({
      where: {
        conversationId: conversation.id,
      },

      orderBy: {
        createdAt: "asc",
      },
    });

    // The conversation ownership has already been verified.
    // Keep sellerId in both mutation conditions as defense-in-depth.
    const [, updatedConversation] =
      await prisma.$transaction([
        prisma.message.updateMany({
          where: {
            conversationId: conversation.id,
            sender: "CUSTOMER",
            isRead: false,
          },

          data: {
            isRead: true,
          },
        }),

        prisma.conversation.updateMany({
          where: {
            id: conversation.id,
            sellerId,
          },

          data: {
            unreadCount: 0,
          },
        }),
      ]);

    const refreshedConversation =
      await prisma.conversation.findFirst({
        where: {
          id: conversation.id,
          sellerId,
        },
      });

    const io = req.app.get("io");

    if (io && refreshedConversation) {
      io.to(`seller_${sellerId}`).emit(
        "conversation_updated",
        {
          conversationId: refreshedConversation.id,
          conversation: refreshedConversation,
        }
      );
    }

    return res.json(messages);
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// SEND MESSAGE
// ─────────────────────────────────────────────
export const sendMessage = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = await getSellerId(req);

    if (!sellerId) {
      return res.status(401).json({
        message: "Unauthorized",
      });
    }

    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        message: "Invalid conversation id",
      });
    }

    const {
      text,
      type = "text",
      mediaUrl,
      metadata,
    } = req.body;

    if (typeof text !== "string" || !text.trim()) {
      return res.status(400).json({
        message: "Message text is required",
      });
    }

    const trimmedText = text.trim();

    const conversation =
      await prisma.conversation.findFirst({
        where: {
          id,
          sellerId,
        },
      });

    if (!conversation) {
      return res.status(404).json({
        message: "Conversation not found",
      });
    }

    /*
     * HYP-002-08:
     * Send through the actual connected channel before recording
     * the message as successfully sent.
     *
     * For WhatsApp, externalThreadId contains the WhatsApp
     * phone_number_id that owns the conversation. This ensures
     * the reply is sent from the correct business number.
     */
    let providerResponse: any;

    try {
      providerResponse = await sendPlatformMessage(
        conversation.platform,
        sellerId,
        conversation.externalUserId,
        trimmedText,
        conversation.externalThreadId ?? undefined
      );
    } catch (error) {
      logger.error(
        "Outbound message delivery failed",
        error
      );

      return res.status(502).json({
        message:
          "Message could not be delivered",
      });
    }

    /*
     * Meta returns the WhatsApp message ID in:
     * { messages: [{ id: "wamid..." }] }
     *
     * Keep provider response data out of the database unless
     * explicitly needed; only persist the external message ID.
     */
    const externalMessageId =
      providerResponse?.messages?.[0]?.id ??
      providerResponse?.message_id ??
      null;

    const message =
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          sender: "SELLER",
          direction: "OUTBOUND",
          status: "SENT",
          text: trimmedText,
          type,
          mediaUrl: mediaUrl ?? null,
          externalMessageId,
          metadata: metadata ?? undefined,
          isRead: true,
        },
      });

    const updateResult =
      await prisma.conversation.updateMany({
        where: {
          id: conversation.id,
          sellerId,
        },

        data: {
          lastMessage: trimmedText,
          lastMessageAt: new Date(),
        },
      });

    if (updateResult.count !== 1) {
      return res.status(404).json({
        message: "Conversation not found",
      });
    }

    const updatedConversation =
      await prisma.conversation.findFirst({
        where: {
          id: conversation.id,
          sellerId,
        },
      });

    const io = req.app.get("io");

    if (io && updatedConversation) {
      io.to(`seller_${sellerId}`).emit(
        "conversation_updated",
        {
          conversationId: updatedConversation.id,
          conversation: updatedConversation,
        }
      );

      io.to(`room_${conversation.id}`).emit(
        "new_message",
        message
      );
    }

    return res.json(message);
  } catch (err) {
    next(err);
  }
};
