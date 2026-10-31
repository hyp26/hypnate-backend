import { Request, Response, NextFunction } from "express";
import prisma from "../prisma/client";
import { getSellerId } from "../services/seller.service";
import { sendMessage as sendPlatformMessage } from "../services/messaging/messaging.service";
import { emitAuthorizedConversationEvents } from "../services/conversationRealtime.service";
import { logger } from "../utils/logger";
import {
  acquirePhoneNumberLock,
  resolveActiveOwner,
  PhoneOwnershipError,
} from "../services/whatsappOwnership.service";

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
    // H-1: emission is authorized against the conversation's
    // CURRENT owner (resolved under the per-phone advisory lock
    // for WhatsApp), not against this request's sellerId, which
    // could be stale after a concurrent ownership transfer.
    // Authorization failure fails closed: no emission.
    if (io) {
      await emitAuthorizedConversationEvents(io, id, [
        {
          event: "conversation_updated",
          payload: {
            conversationId: updated.id,
            conversation: null,
          },
          toSellerRoom: true,
          refreshConversationInPayload: true,
        },
      ]);
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

    const result = await prisma.$transaction(async (tx) => {
      // Read only enough information to identify the conversation
      // and, for WhatsApp, its ownership-lock key.
      const initial = await tx.conversation.findUnique({
        where: { id },
        select: {
          id: true,
          sellerId: true,
          platform: true,
          externalThreadId: true,
        },
      });

      if (!initial) {
        return null;
      }

      let authorizedConversation = initial;

      if (initial.platform === "WHATSAPP") {
        const phoneNumberId =
          typeof initial.externalThreadId === "string"
            ? initial.externalThreadId.trim()
            : "";

        // A WhatsApp conversation without a lock key cannot
        // be safely authorized.
        if (!phoneNumberId) {
          return null;
        }

        // Serialize this read against ownership transfers.
        await acquirePhoneNumberLock(tx, phoneNumberId);

        // Never trust the pre-lock conversation snapshot.
        const current = await tx.conversation.findUnique({
          where: { id },
          select: {
            id: true,
            sellerId: true,
            platform: true,
            externalThreadId: true,
          },
        });

        if (
          !current ||
          current.platform !== "WHATSAPP" ||
          (typeof current.externalThreadId === "string"
            ? current.externalThreadId.trim()
            : "") !== phoneNumberId
        ) {
          return null;
        }

        // Resolve the authoritative owner while holding the lock.
        let owner;

        try {
          owner = await resolveActiveOwner(tx, phoneNumberId);
        } catch (error) {
          if (error instanceof PhoneOwnershipError) {
            return null;
          }

          throw error;
        }

        // Both ownership records must agree.
        if (
          current.sellerId !== owner.sellerId ||
          current.sellerId !== sellerId
        ) {
          return null;
        }

        authorizedConversation = current;
      } else {
        // Non-WhatsApp conversations have no WhatsApp transfer
        // mechanism. Their seller-scoped row remains authoritative.
        if (initial.sellerId !== sellerId) {
          return null;
        }
      }

      // Keep the tenant condition in the mutation as defense
      // in depth. Check it before changing message read state.
      const conversationUpdate =
        await tx.conversation.updateMany({
          where: {
            id: authorizedConversation.id,
            sellerId,
          },
          data: {
            unreadCount: 0,
          },
        });

      if (conversationUpdate.count !== 1) {
        return null;
      }

      // Fetch messages only after authorization, within the
      // same transaction and (for WhatsApp) while holding the lock.
      const messages = await tx.message.findMany({
        where: {
          conversationId: authorizedConversation.id,
        },
        orderBy: {
          createdAt: "asc",
        },
      });

      await tx.message.updateMany({
        where: {
          conversationId: authorizedConversation.id,
          sender: "CUSTOMER",
          isRead: false,
        },
        data: {
          isRead: true,
        },
      });

      return {
        conversationId: authorizedConversation.id,
        messages,
      };
    });

    if (!result) {
      return res.status(404).json({
        message: "Conversation not found",
      });
    }

    const io = req.app.get("io");

    // Realtime authorization is independently checked against
    // the current owner after the read transaction commits.
    if (io) {
      await emitAuthorizedConversationEvents(
        io,
        result.conversationId,
        [
          {
            event: "conversation_updated",
            payload: {
              conversationId: result.conversationId,
              conversation: null,
            },
            toSellerRoom: true,
            refreshConversationInPayload: true,
          },
        ]
      );
    }

    return res.json(result.messages);
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
      /*
       * H-1: authorize both emissions against the conversation's
       * CURRENT owner, resolved at emission time under the shared
       * per-phone advisory lock. The seller-scoped lookup above ran
       * before the emission and may be stale if a concurrent
       * ownership transfer committed in between; the helper fails
       * closed (emits nothing) in that case. The conversation
       * payload is refreshed under the lock so a pre-transfer
       * snapshot is never broadcast.
       */
      await emitAuthorizedConversationEvents(io, conversation.id, [
        {
          event: "conversation_updated",
          payload: {
            conversationId: updatedConversation.id,
            conversation: null,
          },
          toSellerRoom: true,
          refreshConversationInPayload: true,
        },
        {
          event: "new_message",
          payload: message,
        },
      ]);
    }

    return res.json(message);
  } catch (err) {
    next(err);
  }
};
