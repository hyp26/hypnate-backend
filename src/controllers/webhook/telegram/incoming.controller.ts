import { Request, Response } from "express";
import prisma from "../../../prisma/client";
import { decrypt } from "../../../services/crypto.service";
import axios from "axios";

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

    // ✅ Validate sellerId
    if (Number.isNaN(sellerId) || sellerId <= 0) {
      console.error("Invalid sellerId");
      return res.sendStatus(200);
    }

    const chatId = String(message.chat?.id);
    const text = message.text || "";
    const name = message.from?.first_name || "User";

    // ✅ Ignore bot messages
    if (message.from?.is_bot) {
      return res.sendStatus(200);
    }

    // ✅ Get seller Telegram connection
    const connection = await prisma.channelConnection.findFirst({
      where: {
        sellerId,
        platform: "TELEGRAM",
        isActive: true,
      },
    });

    if (!connection?.accessToken) {
      console.error("No active Telegram connection");
      return res.sendStatus(200);
    }

    // ✅ Decrypt stored token
    const BOT_TOKEN = decrypt(connection.accessToken);

    // Optional auto-reply
    try {
      await axios.post(
        `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
        {
          chat_id: chatId,
          text: "Got your message 🚀",
        }
      );
    } catch (err: any) {
      console.error(
        "Telegram reply failed:",
        err?.response?.data || err.message
      );
    }

    // ✅ Find existing conversation
    let conversation = await prisma.conversation.findFirst({
      where: {
        sellerId,
        platform: "TELEGRAM",
        externalUserId: chatId,
      },
    });

    // ✅ Create conversation if not exists
    if (!conversation) {
      conversation = await prisma.conversation.create({
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

    // ✅ Save message
    const newMessage = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        sender: "CUSTOMER",
        direction: "INBOUND",
        text,
      },
    });

    // ✅ Update conversation
    const updatedConversation = await prisma.conversation.update({
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

    // ✅ Socket emit
    const io = req.app.get("io");

    // Chat window update
    io.to(`room_${conversation.id}`).emit("new_message", {
      id: newMessage.id,
      conversationId: conversation.id,
      text,
      sender: "CUSTOMER",
      createdAt: newMessage.createdAt,
    });

    // Sidebar conversation list update
    io.emit("conversation_updated", {
      conversationId: updatedConversation.id,
      conversation: updatedConversation,
    });

    return res.sendStatus(200);
  } catch (err) {
    console.error("Telegram webhook error:", err);
    return res.sendStatus(500);
  }
};