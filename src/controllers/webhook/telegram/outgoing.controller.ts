import { Request, Response } from "express";
import prisma from "../../../prisma/client";
import axios from "axios";
import { decrypt } from "../../../services/crypto.service";

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

    // Get conversation
    const conversation = await prisma.conversation.findUnique({
      where: {
        id: Number(conversationId),
      },
    });

    if (!conversation) {
      return res.status(404).json({
        message: "Conversation not found",
      });
    }

    const chatId = conversation.externalUserId;

    if (!chatId) {
      return res.status(400).json({
        message: "Invalid chatId",
      });
    }

    // Get Telegram connection
    const connection = await prisma.channelConnection.findFirst({
      where: {
        sellerId: conversation.sellerId,
        platform: "TELEGRAM",
        isActive: true,
      },
    });

    if (!connection?.accessToken) {
      return res.status(400).json({
        message: "Telegram not connected",
      });
    }

    // ✅ Decrypt stored token
    const BOT_TOKEN = decrypt(connection.accessToken);

    // Send Telegram message
    try {
      await axios.post(
        `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
        {
          chat_id: chatId,
          text,
        }
      );
    } catch (err: any) {
      console.error(
        "Telegram send failed:",
        err?.response?.data || err.message
      );

      return res.status(500).json({
        message: "Failed to send message to Telegram",
      });
    }

    // Save message
    const newMessage = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        sender: "SELLER",
        direction: "OUTBOUND",
        text,
      },
    });

    // Update conversation
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

    // Chat window update
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

    // Sidebar update
    io.emit("conversation_updated", {
      conversationId: updatedConversation.id,
      conversation: updatedConversation,
    });

    return res.json({
      success: true,
      message: newMessage,
    });
  } catch (err) {
    console.error(
      "Send message error:",
      err
    );

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};