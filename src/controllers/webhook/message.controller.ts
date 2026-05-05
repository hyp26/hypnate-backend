import { Request, Response } from "express";
import prisma from "../../prisma/client";
import axios from "axios";

export const sendMessage = async (req: Request, res: Response) => {
    try {
        const { conversationId, text } = req.body;

        if (!conversationId || !text) {
            return res.status(400).json({ message: "Missing fields" });
        }

        // 1. Get conversation
        const conversation = await prisma.conversation.findUnique({
            where: { id: conversationId },
        });

        if (!conversation) {
            return res.status(404).json({ message: "Conversation not found" });
        }

        // 2. Get chatId
        const chatId = conversation.externalUserId;

        // 3. Get bot token (TEMP: from env)
        const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

        // 4. Send message to Telegram
        await axios.post(
            `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
            {
                chat_id: chatId,
                text,
            }
        );

        // 5. Save message in DB
        await prisma.message.create({
            data: {
                conversationId,
                sender: "SELLER",
                direction: "OUTBOUND",
                text,
            },
        });

        // 6. Update conversation
        await prisma.conversation.update({
            where: { id: conversationId },
            data: {
                lastMessage: text,
                lastMessageAt: new Date(),
            },
        });

        return res.json({ success: true });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: "Failed to send message" });
    }
};