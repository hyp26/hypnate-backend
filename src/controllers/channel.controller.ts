import { Request, Response } from "express";
import prisma from "../prisma/client";
import axios from "axios";

export const connectTelegram = async (req: Request, res: Response) => {
    try {
        const { botToken } = req.body;

        const sellerId = 1; // 🔥 TEMP (replace with auth later)

        if (!botToken) {
            return res.status(400).json({ message: "Bot token required" });
        }

        // 🔥 OPTIONAL: remove old connection (avoid duplicates)
        await prisma.channelConnection.deleteMany({
            where: {
                sellerId,
                platform: "TELEGRAM",
            },
        });

        // 1. Save in DB
        const connection = await prisma.channelConnection.create({
            data: {
                sellerId,
                platform: "TELEGRAM",
                accessToken: botToken,
                isActive: true,
            },
        });

        // 2. 🔥 Set webhook with sellerId
        const webhookUrl = `https://your-ngrok-url/api/webhooks/telegram/${sellerId}`;

        await axios.get(
            `https://api.telegram.org/bot${botToken}/setWebhook?url=${webhookUrl}`
        );

        return res.json({
            success: true,
            message: "Telegram connected successfully",
            webhookUrl,
        });

    } catch (err: any) {
        console.error("Connect Telegram error:", err?.response?.data || err.message);

        return res.status(500).json({
            message: "Failed to connect Telegram",
        });
    }
};