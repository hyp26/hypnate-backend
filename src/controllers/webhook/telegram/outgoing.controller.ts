import { Response } from "express";
import prisma from "../../../prisma/client";
import { AuthRequest } from "../../../middleware/authMiddleware";
import { sendTelegramMessage } from "../../../services/messaging/telegram.service";
import { logger } from "../../../utils/logger";

export const sendMessage = async (
  req: AuthRequest,
  res: Response
) => {
  try {
    const sellerId = req.user?.sellerId;

    if (!sellerId) {
      return res.status(403).json({
        message: "Seller account required",
      });
    }

    const { conversationId, text } = req.body;

    if (
      !conversationId ||
      typeof text !== "string" ||
      !text.trim()
    ) {
      return res.status(400).json({
        message: "Missing fields",
      });
    }

    const id = Number(conversationId);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        message: "Invalid conversation ID",
      });
    }

    const normalizedText = text.trim();

    if (normalizedText.length > 4096) {
      return res.status(400).json({
        message: "Message is too long",
      });
    }

    /*
     * Critical tenant isolation:
     *
     * The conversation must belong to the authenticated seller
     * and must actually be a Telegram conversation.
     */
    const conversation =
      await prisma.conversation.findFirst({
        where: {
          id,
          sellerId,
          platform: "TELEGRAM",
        },
      });

    if (!conversation) {
      return res.status(404).json({
        message: "Conversation not found",
      });
    }

    const providerResponse =
      await sendTelegramMessage(
        sellerId,
        conversation.externalUserId,
        normalizedText
      );

    const externalMessageId =
      providerResponse?.result?.message_id != null
        ? String(providerResponse.result.message_id)
        : null;

    const newMessage =
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          sender: "SELLER",
          direction: "OUTBOUND",
          status: "SENT",
          text: normalizedText,
          ...(externalMessageId
            ? { externalMessageId }
            : {}),
        },
      });

    const updatedConversation =
      await prisma.conversation.update({
        where: {
          id: conversation.id,
        },
        data: {
          lastMessage: normalizedText,
          lastMessageAt: new Date(),
        },
      });

    const io = req.app.get("io");

    if (io) {
      io.to(`room_${conversation.id}`).emit(
        "new_message",
        {
          id: newMessage.id,
          conversationId: conversation.id,
          text: normalizedText,
          sender: "SELLER",
          createdAt: newMessage.createdAt,
        }
      );

      io.to(`seller_${sellerId}`).emit(
        "conversation_updated",
        {
          conversationId: updatedConversation.id,
          conversation: updatedConversation,
        }
      );
    }

    return res.json({
      success: true,
      message: newMessage,
    });
  } catch (err) {
    logger.error(
      "Failed to send Telegram message",
      err
    );

    return res.status(500).json({
      message: "Failed to send message",
    });
  }
};