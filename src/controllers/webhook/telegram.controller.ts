import { Request, Response } from "express";
import prisma from "../../prisma/client";
import axios from "axios";

export const telegramWebhook = async (req: Request, res: Response) => {
    try {
        const message = req.body.message;

        if (!message) return res.sendStatus(200);

        const chatId = message.chat.id.toString();
        const text = message.text || "";
        const name = message.from?.first_name || "User";

        const sellerId = 1; // 🔥 TEMP FIX

        // 🔥 AUTO REPLY
        const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: chatId,
            text: "Got your message 🚀",
        });

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
        console.error(err);
        return res.sendStatus(500);
    }
};