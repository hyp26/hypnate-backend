import { Request, Response } from "express";
import {
  exchangeCodeForAccessToken,
  getBusinesses,
  getWhatsAppBusinessAccounts,
  getPhoneNumbers,
} from "../../../services/messaging/whatsapp.service";

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

    // 1. Exchange code for access token
    const token = await exchangeCodeForAccessToken(code);

    // 2. Get Business Managers
    const businesses = await getBusinesses(
      token.access_token
    );

    if (!businesses.length) {
      return res.status(404).json({
        message: "No Business Manager found",
      });
    }

    // 3. Get WhatsApp Business Accounts
    const wabas = await getWhatsAppBusinessAccounts(
      businesses[0].id,
      token.access_token
    );

    if (!wabas.length) {
      return res.status(404).json({
        message: "No WhatsApp Business Account found",
      });
    }

    // 4. Get Phone Numbers
    const phoneNumbers = await getPhoneNumbers(
      wabas[0].id,
      token.access_token
    );

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