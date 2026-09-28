import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import crypto from "crypto";
import axios from "axios";
import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";
import { encrypt, decrypt } from "../services/crypto.service";
import { logger } from "../utils/logger";
import { ENV } from "../config/env";
import {
  buildWhatsAppResultRedirectUrl,
  createOAuthState,
  DEFAULT_OAUTH_RETURN_TO,
  normalizeReturnTo,
  OAUTH_STATE_MAX_AGE,
  verifyOAuthState,
} from "../utils/whatsapp-oauth-state";
import type { WhatsAppOAuthReturnTo } from "../utils/whatsapp-oauth-state";
import {
  exchangeCodeForAccessToken,
  getBusinesses,
  getWhatsAppBusinessAccounts,
  getPhoneNumbers,
  getWhatsAppBusinessAccount,
  subscribeWabaWebhooks,
  unsubscribeWabaWebhooks,
} from "../services/messaging/whatsapp.service";

/* ----------------------------------------------------
   CONSTANTS
---------------------------------------------------- */

const IS_PROD = ENV.NODE_ENV === "production";

const META_APP_SECRET = ENV.META_APP_SECRET;

if (!META_APP_SECRET) {
  throw new Error("META_APP_SECRET environment variable is missing");
}

/* ----------------------------------------------------
   WHATSAPP CONNECTION METADATA HELPERS
---------------------------------------------------- */

/*
 * Lifecycle state is persisted inside the existing
 * ChannelConnection.metadata JSON column together with the
 * connection assets (business, WABA, phone numbers) that the
 * OAuth callback already stores there.
 */

type WhatsAppConnectionMetadata = {
  businessId?: string | null;
  businessName?: string | null;
  whatsappBusinessId?: string | null;
  phoneNumbers?: Prisma.JsonArray | null;
  connectionStatus?: string | null;
  lastValidatedAt?: string | null;
  tokenExpiresAt?: string | null;
  lastError?: string | null;
};

const readWhatsAppMetadata = (
  metadata: unknown
): WhatsAppConnectionMetadata =>
  (metadata ?? {}) as WhatsAppConnectionMetadata;

/*
 * Only well-known, non-sensitive phone number fields are
 * returned to the browser. No tokens ever leave the server.
 */
const sanitizePhoneNumbers = (phoneNumbers: unknown) =>
  Array.isArray(phoneNumbers)
    ? phoneNumbers
        .filter(
          (phone): phone is Record<string, unknown> =>
            !!phone && typeof phone === "object"
        )
        .map((phone) => ({
          id:
            typeof phone.id === "string"
              ? phone.id
              : String(phone.id ?? ""),
          displayPhoneNumber:
            typeof phone.display_phone_number === "string"
              ? phone.display_phone_number
              : null,
          verifiedName:
            typeof phone.verified_name === "string"
              ? phone.verified_name
              : null,
        }))
    : [];

const redirectWithWhatsAppResult = (
  res: Response,
  outcome: string,
  reason?: string,
  returnTo: WhatsAppOAuthReturnTo = DEFAULT_OAUTH_RETURN_TO
): void => {
  /*
   * The destination is a fixed enum resolved from the signed OAuth
   * state. It can never be an arbitrary or attacker-controlled URL.
   */
  res.redirect(
    buildWhatsAppResultRedirectUrl(
      ENV.FRONTEND_URL,
      outcome,
      reason,
      returnTo
    )
  );
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
     * The return destination is a fixed internal enum
     * ("onboarding" | "settings") - never an arbitrary URL. Unknown
     * values fall back to "settings", which preserves the pre-existing
     * Settings behaviour.
     */
    const returnTo = normalizeReturnTo(req.query.returnTo);

    /*
     * Generate an unpredictable, signed OAuth state.
     *
     * The seller ID and the return context are inside the signed
     * state instead of being directly exposed as `state=123`.
     */
    const state = createOAuthState(sellerId, returnTo, META_APP_SECRET);

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
     * Best-effort return context for the failure paths that run
     * before the state can be fully verified. A state that fails
     * verification falls back to the default "settings" route.
     */
    const earlyReturnTo: WhatsAppOAuthReturnTo = returnedState
      ? verifyOAuthState(returnedState, META_APP_SECRET)?.returnTo ??
        DEFAULT_OAUTH_RETURN_TO
      : DEFAULT_OAUTH_RETURN_TO;

    /*
     * Meta may return an OAuth error when the user cancels
     * or denies authorization.
     */
    if (req.query.error) {
      res.clearCookie("whatsapp_oauth_state", {
        path: "/api/channels/whatsapp/callback",
      });

      return redirectWithWhatsAppResult(
        res,
        "error",
        "authorization_denied",
        earlyReturnTo
      );
    }

    if (!code || !returnedState) {
      return redirectWithWhatsAppResult(
        res,
        "error",
        "invalid_response",
        earlyReturnTo
      );
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
      return redirectWithWhatsAppResult(
        res,
        "error",
        "session_expired",
        earlyReturnTo
      );
    }

    if (storedState !== returnedState) {
      res.clearCookie("whatsapp_oauth_state", {
        path: "/api/channels/whatsapp/callback",
      });

      return redirectWithWhatsAppResult(
        res,
        "error",
        "state_mismatch",
        earlyReturnTo
      );
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

      return redirectWithWhatsAppResult(
        res,
        "error",
        "state_invalid",
        earlyReturnTo
      );
    }

    const { sellerId, returnTo: verifiedReturnTo } = verifiedState;

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
      return redirectWithWhatsAppResult(
        res,
        "error",
        "authorization_failed",
        verifiedReturnTo
      );
    }

    const accessToken = token.access_token;

    /*
     * 2. Fetch Business Managers.
     */
    const businesses = await getBusinesses(accessToken);

    if (!Array.isArray(businesses) || !businesses.length) {
      return redirectWithWhatsAppResult(
        res,
        "error",
        "no_business",
        verifiedReturnTo
      );
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
      return redirectWithWhatsAppResult(
        res,
        "error",
        "no_whatsapp_account",
        verifiedReturnTo
      );
    }

    const whatsappBusiness = wabas[0];

    const wabaId = String(whatsappBusiness.id);

    /*
     * 4. Fetch phone numbers.
     */
    const phoneNumbers = await getPhoneNumbers(
      wabaId,
      accessToken
    );

    /*
     * 5. Subscribe this app to the seller's WABA so messages
     *    and status events start flowing to the Hypnate
     *    webhook immediately.
     */
    let subscriptionOk = false;

    try {
      subscriptionOk = await subscribeWabaWebhooks(
        accessToken,
        wabaId
      );
    } catch (err) {
      logger.error(
        "WhatsApp webhook subscription failed",
        err
      );

      subscriptionOk = false;
    }

    /*
     * 6. Persist the connection with its lifecycle state.
     *
     * The plaintext access token NEVER goes into the response
     * and is stored encrypted only.
     */
    const tokenExpiresInSeconds = Number(token.expires_in);

    const tokenExpiresAt =
      Number.isFinite(tokenExpiresInSeconds) &&
      tokenExpiresInSeconds > 0
        ? new Date(
            Date.now() + tokenExpiresInSeconds * 1000
          ).toISOString()
        : null;

    const connectionMetadata: Prisma.InputJsonObject = {
      businessId: String(business.id),
      businessName:
        typeof business.name === "string"
          ? business.name
          : null,
      whatsappBusinessId: wabaId,
      phoneNumbers: Array.isArray(phoneNumbers)
        ? phoneNumbers
        : [],
      connectionStatus: subscriptionOk
        ? "ACTIVE"
        : "ERROR",
      lastValidatedAt: subscriptionOk
        ? new Date().toISOString()
        : null,
      tokenExpiresAt,
      lastError: subscriptionOk
        ? null
        : "webhook_subscription_failed",
    };

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
        externalAccountId: wabaId,
        metadata: connectionMetadata,
        isActive: true,
      },
      update: {
        name:
          typeof whatsappBusiness.name === "string"
            ? whatsappBusiness.name
            : "WhatsApp Business",
        accessToken: encrypt(accessToken),
        externalAccountId: wabaId,
        metadata: connectionMetadata,
        isActive: true,
      },
    });

    /*
     * 7. Send the browser back to the Hypnate frontend with a
     *    safe, fixed outcome parameter. No Meta payloads, tokens
     *    or internal errors are exposed.
     */
    if (subscriptionOk) {
      return redirectWithWhatsAppResult(
        res,
        "connected",
        undefined,
        verifiedReturnTo
      );
    }

    return redirectWithWhatsAppResult(
      res,
      "error",
      "webhook_subscription_failed",
      verifiedReturnTo
    );
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

    return redirectWithWhatsAppResult(
      res,
      "error",
      "connection_failed",
      verifiedReturnTo
    );
  }
};

/* ----------------------------------------------------
   WHATSAPP CONNECTION STATUS
---------------------------------------------------- */

export const getWhatsAppStatus = async (
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

    const connection =
      await prisma.channelConnection.findFirst({
        where: {
          sellerId,
          platform: "WHATSAPP",
        },
        select: {
          name: true,
          externalAccountId: true,
          isActive: true,
          metadata: true,
          createdAt: true,
          updatedAt: true,
        },
      });

    if (!connection) {
      return res.json({
        connected: false,
        connectionStatus: "NOT_CONNECTED",
      });
    }

    const metadata = readWhatsAppMetadata(
      connection.metadata
    );

    const connectionStatus = !connection.isActive
      ? "DISCONNECTED"
      : metadata.connectionStatus ?? "ACTIVE";

    return res.json({
      connected: connection.isActive,
      connectionStatus,
      businessName: metadata.businessName ?? null,
      whatsappBusinessName:
        typeof connection.name === "string"
          ? connection.name
          : null,
      wabaId: metadata.whatsappBusinessId ?? null,
      phoneNumbers: sanitizePhoneNumbers(
        metadata.phoneNumbers
      ),
      lastValidatedAt: metadata.lastValidatedAt ?? null,
      tokenExpiresAt: metadata.tokenExpiresAt ?? null,
      lastError: metadata.lastError ?? null,
      connectedAt: connection.createdAt,
      updatedAt: connection.updatedAt,
    });
  } catch (err) {
    logger.error("Failed to read WhatsApp status", err);

    return res.status(500).json({
      message: "Could not read WhatsApp connection status",
    });
  }
};

/* ----------------------------------------------------
   VALIDATE WHATSAPP CONNECTION
---------------------------------------------------- */

export const validateWhatsAppConnection = async (
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

    const connection =
      await prisma.channelConnection.findFirst({
        where: {
          sellerId,
          platform: "WHATSAPP",
        },
        select: {
          accessToken: true,
          metadata: true,
        },
      });

    if (!connection || !connection.accessToken) {
      return res.status(400).json({
        message: "WhatsApp is not connected",
      });
    }

    const metadata = readWhatsAppMetadata(
      connection.metadata
    );

    const wabaId = metadata.whatsappBusinessId;

    if (!wabaId) {
      return res.status(400).json({
        message:
          "WhatsApp business account is not configured. Please reconnect WhatsApp.",
      });
    }

    let accessToken: string;

    try {
      accessToken = decrypt(connection.accessToken);
    } catch {
      await prisma.channelConnection.updateMany({
        where: {
          sellerId,
          platform: "WHATSAPP",
        },
        data: {
          metadata: {
            ...metadata,
            connectionStatus: "ERROR",
            lastError: "credential_unreadable",
          },
        },
      });

      return res.status(500).json({
        message:
          "Stored WhatsApp credential could not be read. Please reconnect WhatsApp.",
      });
    }

    /*
     * Validate by fetching the WABA with the stored token.
     * A successful response proves the token is still valid
     * and the account is reachable.
     */
    try {
      const waba = await getWhatsAppBusinessAccount(
        accessToken,
        wabaId
      );

      const validatedAt = new Date().toISOString();

      await prisma.channelConnection.updateMany({
        where: {
          sellerId,
          platform: "WHATSAPP",
        },
        data: {
          isActive: true,
          metadata: {
            ...metadata,
            connectionStatus: "ACTIVE",
            lastValidatedAt: validatedAt,
            lastError: null,
          },
        },
      });

      return res.json({
        valid: true,
        validatedAt,
        whatsappBusinessName:
          waba &&
          typeof waba.name === "string" &&
          waba.name
            ? waba.name
            : null,
      });
    } catch (err) {
      logger.error(
        "WhatsApp connection validation failed",
        err
      );

      await prisma.channelConnection.updateMany({
        where: {
          sellerId,
          platform: "WHATSAPP",
        },
        data: {
          metadata: {
            ...metadata,
            connectionStatus: "ERROR",
            lastError: "validation_failed",
          },
        },
      });

      return res.status(502).json({
        valid: false,
        message:
          "WhatsApp connection could not be validated. Please reconnect WhatsApp.",
      });
    }
  } catch (err) {
    logger.error(
      "Failed to validate WhatsApp connection",
      err
    );

    return res.status(500).json({
      message: "Could not validate WhatsApp connection",
    });
  }
};

/* ----------------------------------------------------
   DISCONNECT WHATSAPP
---------------------------------------------------- */

export const disconnectWhatsApp = async (
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

    const connection =
      await prisma.channelConnection.findFirst({
        where: {
          sellerId,
          platform: "WHATSAPP",
        },
        select: {
          accessToken: true,
          metadata: true,
        },
      });

    if (!connection) {
      return res.json({
        success: true,
        message: "WhatsApp is not connected",
      });
    }

    const metadata = readWhatsAppMetadata(
      connection.metadata
    );

    /*
     * Best effort: unsubscribe the app from the seller's WABA
     * so no further webhook events are delivered. Even if this
     * fails (for example an expired token), the local connection
     * is still disabled below.
     */
    if (connection.accessToken && metadata.whatsappBusinessId) {
      try {
        const accessToken = decrypt(
          connection.accessToken
        );

        await unsubscribeWabaWebhooks(
          accessToken,
          metadata.whatsappBusinessId
        );
      } catch (err) {
        logger.error(
          "WhatsApp webhook unsubscription failed",
          err
        );
      }
    }

    await prisma.channelConnection.updateMany({
      where: {
        sellerId,
        platform: "WHATSAPP",
      },
      data: {
        isActive: false,
        metadata: {
          ...metadata,
          connectionStatus: "DISCONNECTED",
          lastError: null,
        },
      },
    });

    return res.json({
      success: true,
      message: "WhatsApp disconnected",
    });
  } catch (err) {
    logger.error("Failed to disconnect WhatsApp", err);

    return res.status(500).json({
      message: "Could not disconnect WhatsApp",
    });
  }
};
