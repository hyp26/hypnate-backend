import { Request, Response } from "express";
import prisma from "../../../prisma/client";
import { sendTelegramMessage } from "../../../services/messaging/telegram.service";
import { logger } from "../../../utils/logger";

export const telegramWebhook = async (
  req: Request,
  res: Response
) => {
  try {
    const message = req.body?.message;

    if (!message) {
      return res.sendStatus(200);
    }

    const sellerId = Number(req.params.sellerId);

    if (Number.isNaN(sellerId) || sellerId <= 0) {
      return res.sendStatus(200);
    }

    if (message.from?.is_bot) {
      return res.sendStatus(200);
    }

    const chatId = String(message.chat?.id);
    const text = message.text || "";
    const name = message.from?.first_name || "User";

    // Optional auto-reply
    try {
      await sendTelegramMessage(
        sellerId,
        chatId,
        "Got your message 🚀"
      );
    } catch (err) {
      logger.error("Auto reply failed:", err);
    }

    let conversation =
      await prisma.conversation.findFirst({
        where: {
          sellerId,
          platform: "TELEGRAM",
          externalUserId: chatId,
        },
      });

    if (!conversation) {
      conversation =
        await prisma.conversation.create({
          data: {
            sellerId,
            platform: "TELEGRAM",
            externalUserId: chatId,
            customerName: name,
            lastMessage: text,
            lastMessageAt: new Date(),
          },
        });
    }

    const newMessage =
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          sender: "CUSTOMER",
          direction: "INBOUND",
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
          unreadCount: {
            increment: 1,
          },
        },
      });

    const io = req.app.get("io");

    io.to(`room_${conversation.id}`).emit(
      "new_message",
      {
        id: newMessage.id,
        conversationId: conversation.id,
        text,
        sender: "CUSTOMER",
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

    return res.sendStatus(200);
  } catch (err) {
    logger.error(
      "Telegram incoming webhook processing failed:",
      err
    );

    return res.sendStatus(500);
  }
};