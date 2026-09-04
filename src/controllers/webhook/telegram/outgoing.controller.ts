import { Request, Response } from "express";
import prisma from "../../../prisma/client";
import { sendTelegramMessage } from "../../../services/messaging/telegram.service";
import { logger } from "../../../utils/logger";

export const sendMessage = async (
  req: Request,
  res: Response
) => {
  try {
    const { conversationId, text } = req.body;

    if (!conversationId || !text?.trim()) {
      return res.status(400).json({
        message: "Missing fields",
      });
    }

    const conversation =
      await prisma.conversation.findUnique({
        where: {
          id: Number(conversationId),
        },
      });

    if (!conversation) {
      return res.status(404).json({
        message: "Conversation not found",
      });
    }

    await sendTelegramMessage(
      conversation.sellerId,
      conversation.externalUserId,
      text
    );

    const newMessage =
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          sender: "SELLER",
          direction: "OUTBOUND",
          text,
        },
      });

    const updatedConversation =
      await prisma.conversation.update({
        where: {
          id: conversation.id,
        },
        data: {
          lastMessage: text,
          lastMessageAt: new Date(),
        },
      });

    const io = req.app.get("io");

    io.to(`room_${conversation.id}`).emit(
      "new_message",
      {
        id: newMessage.id,
        conversationId: conversation.id,
        text,
        sender: "SELLER",
        createdAt: newMessage.createdAt,
      }
    );

    io.emit("conversation_updated", {
      conversationId: updatedConversation.id,
      conversation: updatedConversation,
    });

    return res.json({
      success: true,
      message: newMessage,
    });
  } catch (err) {
    logger.error("Failed to send Telegram message", err);

    return res.status(500).json({
      message: "Failed to send message",
    });
  }
};