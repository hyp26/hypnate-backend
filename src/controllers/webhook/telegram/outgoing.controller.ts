import { Request, Response } from "express";
import prisma from "../../../prisma/client";
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

        const chatId = conversation.externalUserId;

        if (!chatId) {
            return res.status(400).json({ message: "Invalid chatId" });
        }

        // 2. Get seller bot connection
        const connection = await prisma.channelConnection.findFirst({
            where: {
                sellerId: conversation.sellerId,
                platform: "TELEGRAM",
                isActive: true,
            },
        });

        if (!connection || !connection.accessToken) {
            return res.status(400).json({ message: "Telegram not connected" });
        }

        const BOT_TOKEN = connection.accessToken;

        // 3. Send message to Telegram (safe block)
        try {
            await axios.post(
                `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
                {
                    chat_id: chatId,
                    text,
                }
            );
        } catch (err: any) {
            console.error("Telegram send failed:", err?.response?.data || err.message);

            return res.status(500).json({
                message: "Failed to send message to Telegram",
            });
        }

        // 4. Save message in DB
        await prisma.message.create({
            data: {
                conversationId,
                sender: "SELLER",
                direction: "OUTBOUND",
                text,
            },
        });

        // 5. Update conversation
        await prisma.conversation.update({
            where: { id: conversationId },
            data: {
                lastMessage: text,
                lastMessageAt: new Date(),
            },
        });

        return res.json({ success: true });

    } catch (err) {
        console.error("Send message error:", err);
        return res.status(500).json({ message: "Internal server error" });
    }
};