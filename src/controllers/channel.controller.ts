import { Request, Response } from "express";
import prisma from "../prisma/client";
import axios from "axios";
import { AuthRequest } from "../middleware/authMiddleware";
import { encrypt } from "../services/crypto.service";

export const connectTelegram = async (
  req: Request,
  res: Response
) => {
  try {
    const authReq = req as AuthRequest;

    const sellerId = authReq.user?.sellerId;

    if (!sellerId) {
      return res.status(401).json({
        message: "Unauthorized",
      });
    }

    const { botToken } = req.body;

    if (!botToken) {
      return res.status(400).json({
        message: "Bot token required",
      });
    }

    const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL;

    if (!WEBHOOK_BASE_URL) {
      return res.status(500).json({
        message: "WEBHOOK_BASE_URL not configured",
      });
    }

    // ✅ Verify bot token first
    const botInfo = await axios.get(
      `https://api.telegram.org/bot${botToken}/getMe`
    );

    if (!botInfo.data?.ok) {
      return res.status(400).json({
        message: "Invalid Telegram bot token",
      });
    }

    const webhookUrl =
      `${WEBHOOK_BASE_URL}/api/webhooks/telegram/${sellerId}`;

    // ✅ Register webhook
    await axios.get(
      `https://api.telegram.org/bot${botToken}/setWebhook`,
      {
        params: {
          url: webhookUrl,
        },
      }
    );

    // ✅ Remove old connection
    await prisma.channelConnection.deleteMany({
      where: {
        sellerId,
        platform: "TELEGRAM",
      },
    });

    // ✅ Save encrypted token
    await prisma.channelConnection.create({
      data: {
        sellerId,
        platform: "TELEGRAM",
        accessToken: encrypt(botToken),
        isActive: true,
      },
    });

    return res.json({
      success: true,
      message: "Telegram connected successfully",
      botName: botInfo.data.result?.first_name,
      botUsername: botInfo.data.result?.username,
      webhookUrl,
    });
  } catch (err: any) {
    console.error(
      "Connect Telegram error:",
      err?.response?.data || err.message
    );

    return res.status(500).json({
      message: "Failed to connect Telegram",
    });
  }
};