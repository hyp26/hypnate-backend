import { Request, Response } from "express";
import prisma from "../prisma/client";
import axios from "axios";
import { AuthRequest } from "../middleware/authMiddleware";
import { encrypt } from "../services/crypto.service";
import {
  exchangeCodeForAccessToken,
  getBusinesses,
  getWhatsAppBusinessAccounts,
  getPhoneNumbers,
} from "../services/messaging/whatsapp.service";

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


//connect whatsapp

export const connectWhatsApp = async (
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

    const url =
      `https://www.facebook.com/v23.0/dialog/oauth` +
      `?client_id=${process.env.META_APP_ID}` +
      `&redirect_uri=${encodeURIComponent(
        process.env.META_REDIRECT_URI!
      )}` +
      `&state=${sellerId}` +
      `&scope=` +
      [
        "business_management",
        "whatsapp_business_management",
        "whatsapp_business_messaging",
      ].join(",");

    return res.redirect(url);
  } catch (err: any) {
    console.error(
      "Connect WhatsApp error:",
      err.response?.data || err.message
    );

    return res.status(500).json({
      message: "Failed to start WhatsApp connection",
    });
  }
};

//whatsapp callback

export const whatsappCallback = async (
  req: Request,
  res: Response
) => {
  try {
    const code = req.query.code as string;
    const sellerId = Number(req.query.state);

    if (!code) {
      return res.status(400).json({
        message: "Authorization code is missing",
      });
    }

    // 1. Exchange authorization code
    const token = await exchangeCodeForAccessToken(code);

    // 2. Fetch Business Managers
    const businesses = await getBusinesses(
      token.access_token
    );

    if (!businesses.length) {
      return res.status(404).json({
        message: "No Business Manager found",
      });
    }

    // 3. Fetch WhatsApp Business Accounts
    const wabas = await getWhatsAppBusinessAccounts(
      businesses[0].id,
      token.access_token
    );

    console.log("Businesses");
    console.log(JSON.stringify(businesses, null, 2));

    console.log("WABAs");
    console.log(JSON.stringify(wabas, null, 2));

    if (!wabas.length) {
      return res.status(404).json({
        message: "No WhatsApp Business Account found",
      });
    }

    // 4. Fetch phone numbers
    const phoneNumbers = await getPhoneNumbers(
      wabas[0].id,
      token.access_token
    );

    console.log("Phone Numbers");
    console.log(JSON.stringify(phoneNumbers, null, 2));

    return res.json({
      success: true,
      sellerId,
      accessToken: token.access_token,
      business: businesses[0],
      whatsappBusiness: wabas[0],
      phoneNumbers,
    });
  } catch (err: any) {
    console.error(
      "WhatsApp callback error:",
      err.response?.data || err.message
    );

    return res.status(500).json({
      message: "WhatsApp connection failed",
      error: err.response?.data || err.message,
    });
  }
};