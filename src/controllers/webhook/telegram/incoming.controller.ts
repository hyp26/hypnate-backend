import { Request, Response } from "express";
import prisma from "../../../prisma/client";
import axios from "axios";

export const telegramWebhook = async (req: Request, res: Response) => {
    try {
        const message = req.body.message;

        if (!message) return res.sendStatus(200);

        const chatId = message.chat.id.toString();
        const text = message.text || "";
        const name = message.from?.first_name || "User";

        const sellerId = Number(req.params.sellerId);

        // ❗ Validate sellerId
        if (!sellerId) {
            console.error("Invalid sellerId");
            return res.sendStatus(200);
        }

        // 🔥 Get seller's bot
        const connection = await prisma.channelConnection.findFirst({
            where: {
                sellerId,
                platform: "TELEGRAM",
                isActive: true,
            },
        });

        if (!connection || !connection.accessToken) {
            console.error("No active Telegram connection");
            return res.sendStatus(200);
        }

        const BOT_TOKEN = connection.accessToken;

        // 🔥 Safe auto-reply
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

        // 1. FIND OR CREATE CONVERSATION
        let conversation = await prisma.conversation.findFirst({
            where: {
                sellerId,
                platform: "TELEGRAM",
                externalUserId: chatId,
            },
        });

        if (!conversation) {
            conversation = await prisma.conversation.create({
                data: {
                    sellerId,
                    platform: "TELEGRAM",
                    externalUserId: chatId,
                    customerName: name,
                },
            });
        }

        // 2. SAVE MESSAGE
        await prisma.message.create({
            data: {
                conversationId: conversation.id,
                sender: "CUSTOMER",
                direction: "INBOUND",
                text,
            },
        });

        // 3. UPDATE CONVERSATION
        await prisma.conversation.update({
            where: { id: conversation.id },
            data: {
                lastMessage: text,
                lastMessageAt: new Date(),
                unreadCount: { increment: 1 },
            },
        });

        return res.sendStatus(200);
    } catch (err) {
        console.error("Webhook error:", err);
        return res.sendStatus(500);
    }
};