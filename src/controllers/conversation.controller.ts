import { Request, Response, NextFunction } from "express";
import { Prisma } from "@prisma/client";
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
import { resolveConversationAccess } from "../services/conversationAccess.service";

type ConversationListFilters = {
  platform?: string;
  status?: string;
  search?: string;
};

const getAccessibleConversations = async (
  sellerId: number,
  filters: ConversationListFilters = {}
) => {
  return prisma.$transaction(async (tx) => {
    const conditions: Prisma.ConversationWhereInput[] = [
      {
        OR: [
          { sellerId },
          {
            shares: {
              some: {
                sharedWithSellerId: sellerId,
                isActive: true,
              },
            },
          },
        ],
      },
    ];

    if (filters.platform && filters.platform !== "all") {
      conditions.push({
        platform: filters.platform.toUpperCase() as any,
      });
    }

    if (filters.status) {
      conditions.push({
        status: filters.status.toUpperCase() as any,
      });
    }

    if (filters.search) {
      conditions.push({
        OR: [
          {
            customerName: {
              contains: filters.search,
              mode: "insensitive",
            },
          },
          {
            lastMessage: {
              contains: filters.search,
              mode: "insensitive",
            },
          },
          {
            customerPhone: {
              contains: filters.search,
              mode: "insensitive",
            },
          },
        ],
      });
    }

    const candidates = await tx.conversation.findMany({
      where: {
        AND: conditions,
      },
      select: {
        id: true,
      },
      orderBy: {
        lastMessageAt: "desc",
      },
    });

    const accessible = [];

    for (const candidate of candidates) {
      const access = await resolveConversationAccess(
        tx,
        candidate.id,
        sellerId
      );

      if (access) {
        accessible.push(access.conversation);
      }
    }

    return accessible;
  });
};

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

    const conversations = await getAccessibleConversations(sellerId);

    const stats = conversations.reduce(
      (result, conversation) => {
        result.total++;

        if (conversation.status === "OPEN") result.open++;
        if (conversation.status === "PENDING") result.pending++;
        if (conversation.status === "RESOLVED") result.resolved++;

        result.totalUnread += conversation.unreadCount;

        return result;
      },
      {
        total: 0,
        open: 0,
        pending: 0,
        resolved: 0,
        totalUnread: 0,
      }
    );

    return res.json(stats);
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

    const platform =
      typeof req.query.platform === "string"
        ? req.query.platform
        : undefined;

    const status =
      typeof req.query.status === "string"
        ? req.query.status
        : undefined;

    const search =
      typeof req.query.search === "string"
        ? req.query.search
        : "";

    const conversations = await getAccessibleConversations(sellerId, {
      platform,
      status,
      search,
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

    const conversation = await prisma.$transaction(async (tx) => {
      const access = await resolveConversationAccess(
        tx,
        id,
        sellerId
      );

      return access?.conversation ?? null;
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

    
    const result = await prisma.$transaction(
      async (tx) => {
        // Resolve owner or explicitly shared access.
        // For WhatsApp, this also acquires the phone lock and
        // validates normalized ownership before granting access.
        const access = await resolveConversationAccess(
          tx,
          id,
          sellerId
        );

        if (!access) {
          return null;
        }

        const conversationId = access.conversation.id;
        const ownerSellerId = access.ownerSellerId;

        // Always mutate the original owner's conversation.
        // Never substitute the requesting seller's ID here.
        const conversationUpdate = await tx.conversation.updateMany({
          where: {
            id: conversationId,
            sellerId: ownerSellerId,
          },
          data: {
            unreadCount: 0,
          },
        });

        if (conversationUpdate.count !== 1) {
          return null;
        }

        // Fetch history only after authorization.
        const messages = await tx.message.findMany({
          where: {
            conversationId,
          },
          orderBy: {
            createdAt: "asc",
          },
        });

        await tx.message.updateMany({
          where: {
            conversationId,
            sender: "CUSTOMER",
            isRead: false,
          },
          data: {
            isRead: true,
          },
        });

        return {
          conversationId,
          messages,
        };
      },
      {
        maxWait: 10000,
        timeout: 30000,
      }
    );


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

    const access = await prisma.$transaction(async (tx) => {
      return resolveConversationAccess(tx, id, sellerId);
    });

    if (!access) {
      return res.status(404).json({
        message: "Conversation not found",
      });
    }

    const conversation = access.conversation;
    const ownerSellerId = access.ownerSellerId;

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
        ownerSellerId,
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
          sellerId: ownerSellerId,
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
          sellerId: ownerSellerId,
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
