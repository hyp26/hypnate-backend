import { Request, Response } from "express";
import crypto from "crypto";
import axios from "axios";
import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";
import { encrypt } from "../services/crypto.service";
import { logger } from "../utils/logger";
import { ENV } from "../config/env";
import {
  exchangeCodeForAccessToken,
  getBusinesses,
  getWhatsAppBusinessAccounts,
  getPhoneNumbers,
} from "../services/messaging/whatsapp.service";

/* ----------------------------------------------------
   CONSTANTS
---------------------------------------------------- */

const IS_PROD = process.env.NODE_ENV === "production";

const OAUTH_STATE_MAX_AGE = 10 * 60 * 1000; // 10 minutes

const META_APP_SECRET = ENV.META_APP_SECRET;

if (!META_APP_SECRET) {
  throw new Error("META_APP_SECRET environment variable is missing");
}

/* ----------------------------------------------------
   WHATSAPP OAUTH STATE
---------------------------------------------------- */

/**
 * OAuth state format:
 *
 * base64url(payload).base64url(signature)
 *
 * Payload contains:
 * - sellerId
 * - issuedAt
 * - random nonce
 *
 * The HMAC prevents an attacker from modifying the seller ID
 * or generating their own valid OAuth state.
 */
const createOAuthState = (sellerId: number): string => {
  const payload = {
    sellerId,
    issuedAt: Date.now(),
    nonce: crypto.randomBytes(32).toString("hex"),
  };

  const payloadEncoded = Buffer.from(
    JSON.stringify(payload),
    "utf8"
  ).toString("base64url");

  const signature = crypto
    .createHmac("sha256", META_APP_SECRET)
    .update(payloadEncoded)
    .digest("base64url");

  return `${payloadEncoded}.${signature}`;
};

/**
 * Verify and decode OAuth state.
 *
 * Returns the seller ID only after:
 * - validating the state structure
 * - validating the HMAC signature
 * - validating the timestamp
 */
const verifyOAuthState = (
  state: string
): { sellerId: number } | null => {
  try {
    const parts = state.split(".");

    if (parts.length !== 2) {
      return null;
    }

    const [payloadEncoded, receivedSignature] = parts;

    if (!payloadEncoded || !receivedSignature) {
      return null;
    }

    const expectedSignature = crypto
      .createHmac("sha256", META_APP_SECRET)
      .update(payloadEncoded)
      .digest("base64url");

    const receivedBuffer = Buffer.from(
      receivedSignature,
      "utf8"
    );

    const expectedBuffer = Buffer.from(
      expectedSignature,
      "utf8"
    );

    if (
      receivedBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(
        receivedBuffer,
        expectedBuffer
      )
    ) {
      return null;
    }

    const payloadJson = Buffer.from(
      payloadEncoded,
      "base64url"
    ).toString("utf8");

    const payload = JSON.parse(payloadJson) as {
      sellerId?: unknown;
      issuedAt?: unknown;
      nonce?: unknown;
    };

    if (
      typeof payload.sellerId !== "number" ||
      !Number.isInteger(payload.sellerId) ||
      payload.sellerId <= 0
    ) {
      return null;
    }

    if (
      typeof payload.issuedAt !== "number" ||
      !Number.isFinite(payload.issuedAt)
    ) {
      return null;
    }

    if (
      typeof payload.nonce !== "string" ||
      payload.nonce.length < 32
    ) {
      return null;
    }

    const age = Date.now() - payload.issuedAt;

    if (
      age < 0 ||
      age > OAUTH_STATE_MAX_AGE
    ) {
      return null;
    }

    return {
      sellerId: payload.sellerId,
    };
  } catch {
    return null;
  }
};

/* ----------------------------------------------------
   TELEGRAM CONNECTION
---------------------------------------------------- */

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

    if (
      typeof botToken !== "string" ||
      botToken.trim().length === 0
    ) {
      return res.status(400).json({
        message: "Bot token required",
      });
    }

    const WEBHOOK_BASE_URL = ENV.WEBHOOK_BASE_URL;

    if (!WEBHOOK_BASE_URL) {
      return res.status(500).json({
        message: "WEBHOOK_BASE_URL not configured",
      });
    }

    // Verify bot token first.
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

    /*
     * Generate a cryptographically secure secret for Telegram's
     * X-Telegram-Bot-Api-Secret-Token header.
     *
     * This secret is NOT derived from sellerId and is never
     * returned to the browser.
     */
    const webhookSecret = crypto
      .randomBytes(32)
      .toString("base64url");

    /*
     * Register the webhook with Telegram.
     *
     * Telegram will include this exact secret in the
     * X-Telegram-Bot-Api-Secret-Token header on every
     * webhook request.
     */
    const webhookResponse = await axios.post(
      `https://api.telegram.org/bot${botToken}/setWebhook`,
      {
        url: webhookUrl,
        secret_token: webhookSecret,
      }
    );

    if (!webhookResponse.data?.ok) {
      return res.status(502).json({
        message: "Failed to register Telegram webhook",
      });
    }

    // Remove old Telegram connection.
    await prisma.channelConnection.deleteMany({
      where: {
        sellerId,
        platform: "TELEGRAM",
      },
    });

    /*
     * Save both credentials encrypted at rest.
     *
     * The webhook secret must never be stored in plaintext.
     */
    await prisma.channelConnection.create({
      data: {
        sellerId,
        platform: "TELEGRAM",
        accessToken: encrypt(botToken),
        webhookSecret: encrypt(webhookSecret),
        webhookUrl,
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
  } catch (err) {
    /*
     * Do not log Telegram API response bodies or credentials.
     */
    logger.error("Failed to connect Telegram", err);

    return res.status(500).json({
      message: "Failed to connect Telegram",
    });
  }
};

/* ----------------------------------------------------
   CONNECT WHATSAPP
---------------------------------------------------- */

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

    if (!ENV.META_APP_ID) {
      return res.status(500).json({
        message: "WhatsApp integration is not configured",
      });
    }

    if (!ENV.META_REDIRECT_URI) {
      return res.status(500).json({
        message: "WhatsApp callback is not configured",
      });
    }

    /*
     * Generate an unpredictable, signed OAuth state.
     *
     * The seller ID is inside the signed state instead of being
     * directly exposed as `state=123`.
     */
    const state = createOAuthState(sellerId);

    /*
     * Store the exact OAuth state in an HttpOnly cookie.
     *
     * SameSite=Lax allows the OAuth provider's top-level redirect
     * back to our callback while preventing ordinary cross-site
     * requests from sending the cookie.
     */
    res.cookie("whatsapp_oauth_state", state, {
      httpOnly: true,
      secure: IS_PROD,
      sameSite: "lax",
      maxAge: OAUTH_STATE_MAX_AGE,
      path: "/api/channels/whatsapp/callback",
    });

    const params = new URLSearchParams({
      client_id: ENV.META_APP_ID,
      redirect_uri: ENV.META_REDIRECT_URI,
      state,
      scope: [
        "business_management",
        "whatsapp_business_management",
        "whatsapp_business_messaging",
      ].join(","),
    });

    const url =
      `https://www.facebook.com/v23.0/dialog/oauth?${params.toString()}`;

    return res.redirect(url);
  } catch (err) {
    logger.error("Failed to connect WhatsApp", err);

    return res.status(500).json({
      message: "Failed to start WhatsApp connection",
    });
  }
};

/* ----------------------------------------------------
   WHATSAPP CALLBACK
---------------------------------------------------- */

export const whatsappCallback = async (
  req: Request,
  res: Response
) => {
  try {
    const code =
      typeof req.query.code === "string"
        ? req.query.code
        : undefined;

    const returnedState =
      typeof req.query.state === "string"
        ? req.query.state
        : undefined;

    /*
     * Meta may return an OAuth error when the user cancels
     * or denies authorization.
     */
    if (req.query.error) {
      res.clearCookie("whatsapp_oauth_state", {
        path: "/api/channels/whatsapp/callback",
      });

      return res.status(400).json({
        message: "WhatsApp authorization was not completed",
      });
    }

    if (!code || !returnedState) {
      return res.status(400).json({
        message: "Invalid WhatsApp authorization response",
      });
    }

    /*
     * CSRF PROTECTION:
     *
     * The state returned by Meta must exactly match the state
     * stored in the user's HttpOnly cookie.
     */
    const storedState = req.cookies?.whatsapp_oauth_state;

    if (
      !storedState ||
      typeof storedState !== "string"
    ) {
      return res.status(400).json({
        message: "OAuth session expired or is invalid",
      });
    }

    if (storedState !== returnedState) {
      res.clearCookie("whatsapp_oauth_state", {
        path: "/api/channels/whatsapp/callback",
      });

      return res.status(400).json({
        message: "Invalid OAuth state",
      });
    }

    /*
     * Verify the cryptographic signature and expiration.
     */
    const verifiedState =
      verifyOAuthState(returnedState);

    if (!verifiedState) {
      res.clearCookie("whatsapp_oauth_state", {
        path: "/api/channels/whatsapp/callback",
      });

      return res.status(400).json({
        message: "Invalid or expired OAuth state",
      });
    }

    const { sellerId } = verifiedState;

    /*
     * The state cookie is single-use from our application's
     * perspective. Clear it before doing the external API work.
     */
    res.clearCookie("whatsapp_oauth_state", {
      path: "/api/channels/whatsapp/callback",
    });

    /*
     * 1. Exchange authorization code for Meta access token.
     *
     * The token remains server-side.
     */
    const token = await exchangeCodeForAccessToken(code);

    if (
      !token ||
      typeof token.access_token !== "string" ||
      !token.access_token
    ) {
      return res.status(502).json({
        message: "WhatsApp authorization failed",
      });
    }

    const accessToken = token.access_token;

    /*
     * 2. Fetch Business Managers.
     */
    const businesses = await getBusinesses(accessToken);

    if (!Array.isArray(businesses) || !businesses.length) {
      return res.status(404).json({
        message: "No Business Manager found",
      });
    }

    const business = businesses[0];

    /*
     * 3. Fetch WhatsApp Business Accounts.
     */
    const wabas = await getWhatsAppBusinessAccounts(
      String(business.id),
      accessToken
    );

    if (!Array.isArray(wabas) || !wabas.length) {
      return res.status(404).json({
        message: "No WhatsApp Business Account found",
      });
    }

    const whatsappBusiness = wabas[0];

    /*
     * 4. Fetch phone numbers.
     */
    const phoneNumbers = await getPhoneNumbers(
      String(whatsappBusiness.id),
      accessToken
    );

    /*
     * 5. Store the credential securely on the server.
     *
     * The plaintext access token NEVER goes into the response.
     */
    await prisma.channelConnection.upsert({
      where: {
        sellerId_platform: {
          sellerId,
          platform: "WHATSAPP",
        },
      },
      create: {
        sellerId,
        platform: "WHATSAPP",
        name:
          typeof whatsappBusiness.name === "string"
            ? whatsappBusiness.name
            : "WhatsApp Business",
        accessToken: encrypt(accessToken),
        externalAccountId: String(
          whatsappBusiness.id
        ),
        metadata: {
          businessId: String(business.id),
          businessName:
            typeof business.name === "string"
              ? business.name
              : null,
          whatsappBusinessId: String(
            whatsappBusiness.id
          ),
          phoneNumbers: Array.isArray(phoneNumbers)
            ? phoneNumbers
            : [],
        },
        isActive: true,
      },
      update: {
        name:
          typeof whatsappBusiness.name === "string"
            ? whatsappBusiness.name
            : "WhatsApp Business",
        accessToken: encrypt(accessToken),
        externalAccountId: String(
          whatsappBusiness.id
        ),
        metadata: {
          businessId: String(business.id),
          businessName:
            typeof business.name === "string"
              ? business.name
              : null,
          whatsappBusinessId: String(
            whatsappBusiness.id
          ),
          phoneNumbers: Array.isArray(phoneNumbers)
            ? phoneNumbers
            : [],
        },
        isActive: true,
      },
    });

    /*
     * IMPORTANT:
     *
     * Never return:
     * - accessToken
     * - Meta OAuth token response
     * - raw Business Manager response
     * - raw WABA response
     * - raw API errors
     */
    return res.json({
      success: true,
      message: "WhatsApp connected successfully",
      sellerId,
      business: {
        id: business.id,
        name:
          typeof business.name === "string"
            ? business.name
            : null,
      },
      whatsappBusiness: {
        id: whatsappBusiness.id,
        name:
          typeof whatsappBusiness.name === "string"
            ? whatsappBusiness.name
            : null,
      },
      phoneNumbers: Array.isArray(phoneNumbers)
        ? phoneNumbers
        : [],
    });
  } catch (err) {
    /*
     * SECURITY:
     *
     * Do NOT log err.response.data because Meta API errors
     * may contain sensitive information.
     *
     * Do NOT return the underlying error to the browser.
     */
    logger.error("Failed to connect WhatsApp", err);

    return res.status(500).json({
      message: "WhatsApp connection failed",
    });
  }
};