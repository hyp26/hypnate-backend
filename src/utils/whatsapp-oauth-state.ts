import crypto from "crypto";

/* ----------------------------------------------------
   WHATSAPP OAUTH STATE (signed, seller-bound)
---------------------------------------------------- */

/**
 * Fixed internal destinations a WhatsApp OAuth flow may return to.
 * This is an enum of known Hypnate routes - it is never an
 * attacker-controlled redirect URL.
 */
export type WhatsAppOAuthReturnTo = "onboarding" | "settings";

/** Signed OAuth state lifetime (mirrors the state cookie maxAge). */
export const OAUTH_STATE_MAX_AGE = 10 * 60 * 1000; // 10 minutes

/** Canonical frontend paths for the allowed return contexts. */
export const WHATSAPP_OAUTH_RETURN_PATHS: Record<
  WhatsAppOAuthReturnTo,
  string
> = {
  onboarding: "/onboarding",
  settings: "/settings",
};

/** Default return context (preserves the pre-existing Settings flow). */
export const DEFAULT_OAUTH_RETURN_TO: WhatsAppOAuthReturnTo = "settings";

/**
 * Accept only the two known return contexts. Missing, malformed, or
 * unknown values safely fall back to "settings".
 */
export const normalizeReturnTo = (value: unknown): WhatsAppOAuthReturnTo =>
  value === "onboarding" ? "onboarding" : "settings";

/**
 * OAuth state format:
 *
 * base64url(payload).base64url(signature)
 *
 * Payload contains:
 * - sellerId
 * - returnTo (fixed enum, so the redirect destination survives the
 *   complete Meta OAuth round-trip and cannot be forged)
 * - issuedAt
 * - random nonce
 *
 * The HMAC prevents an attacker from modifying the seller ID or the
 * return context, or generating their own valid OAuth state.
 */
export const createOAuthState = (
  sellerId: number,
  returnTo: WhatsAppOAuthReturnTo,
  appSecret: string
): string => {
  const payload = {
    sellerId,
    returnTo,
    issuedAt: Date.now(),
    nonce: crypto.randomBytes(32).toString("hex"),
  };

  const payloadEncoded = Buffer.from(
    JSON.stringify(payload),
    "utf8"
  ).toString("base64url");

  const signature = crypto
    .createHmac("sha256", appSecret)
    .update(payloadEncoded)
    .digest("base64url");

  return `${payloadEncoded}.${signature}`;
};

/**
 * Verify and decode OAuth state.
 *
 * Returns the seller ID and return context only after:
 * - validating the state structure
 * - validating the HMAC signature
 * - validating the timestamp
 *
 * A payload whose returnTo is missing or unknown (for example a state
 * issued before this field existed) safely resolves to "settings".
 */
export const verifyOAuthState = (
  state: string,
  appSecret: string,
  now: number = Date.now()
): { sellerId: number; returnTo: WhatsAppOAuthReturnTo } | null => {
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
      .createHmac("sha256", appSecret)
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
      returnTo?: unknown;
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

    const age = now - payload.issuedAt;

    if (
      age < 0 ||
      age > OAUTH_STATE_MAX_AGE
    ) {
      return null;
    }

    return {
      sellerId: payload.sellerId,
      returnTo: normalizeReturnTo(payload.returnTo),
    };
  } catch {
    return null;
  }
};

/**
 * Build the fixed frontend URL the browser is sent back to after the
 * WhatsApp OAuth callback.
 *
 * `frontendUrl` is the canonical frontend origin (ENV.FRONTEND_URL) and
 * `returnTo` selects one of the two known routes. An arbitrary
 * user-supplied URL can never reach this function.
 */
export const buildWhatsAppResultRedirectUrl = (
  frontendUrl: string,
  outcome: string,
  reason?: string,
  returnTo: WhatsAppOAuthReturnTo = DEFAULT_OAUTH_RETURN_TO
): string => {
  const redirectUrl = new URL(
    WHATSAPP_OAUTH_RETURN_PATHS[returnTo],
    frontendUrl
  );

  redirectUrl.searchParams.set("wa", outcome);

  if (reason) {
    redirectUrl.searchParams.set("reason", reason);
  }

  return redirectUrl.toString();
};
