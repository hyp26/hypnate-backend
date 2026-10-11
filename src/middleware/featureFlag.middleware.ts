import { Request, Response, NextFunction } from "express";
import {
  getFeatureFlags,
  FeatureFlags,
} from "../services/featureFlags.service";
import { logger } from "../utils/logger";

/*
 * P1-004 — Feature-flag enforcement middleware.
 *
 * Two independent, reusable middlewares built on the shared
 * feature-flag service:
 *
 * 1. requireRegistrationEnabled
 *    Guards the PUBLIC registration route. Runs BEFORE the register
 *    controller, so when newUserRegistration is disabled no account
 *    side effects (Seller/User creation, verification email, refresh
 *    session) can happen. The stored backend value is authoritative —
 *    nothing from the request body is consulted. A flag-read failure
 *    is forwarded to the existing error handler (fail-safe, never
 *    silently open).
 *
 * 2. maintenanceModeMiddleware
 *    Mounted once in the application routing layer BEFORE all API
 *    routes. When maintenanceMode is enabled, user-facing API routes
 *    respond 503 with a machine-readable body — even for callers that
 *    bypass the frontend. Operational exemptions keep the system
 *    operable while maintenance is on:
 *      - /api/admin (and all descendants, incl. admin login and the
 *        feature-flag endpoints, so an admin can turn maintenance off)
 *      - /api/health (Render / external health checks — EXACT path
 *        only, descendants stay gated)
 *      - /api/webhooks/telegram (inbound Telegram webhooks)
 *      - /api/webhooks/whatsapp (inbound WhatsApp webhooks)
 *      - /api/billing/webhook (payment-provider webhook — EXACT path
 *        only; other /api/billing routes stay gated)
 *    OPTIONS preflight requests always pass through unchanged so CORS
 *    behavior is preserved. Non-API paths (static assets) are not
 *    gated.
 *
 *    The exemption list is deliberately narrow: e.g. the legacy
 *    authenticated /api/messages/send route is NOT whitelisted. A new
 *    exemption requires an operational justification and a test.
 *
 *    Failure mode: if the feature-flag read fails, ordinary API traffic
 *    is REJECTED with 503 (fail closed) — never waved through on the
 *    assumption maintenance is off — while the exempt admin and
 *    webhook paths remain reachable (they do not perform a flag read
 *    at all).
 *
 * No caching: each enforcement decision reads the persisted flags, so
 * every instance reflects an administrator's change immediately.
 */

export type FeatureFlagsReader = () => Promise<FeatureFlags>;

/*
 * Paths that must remain reachable while maintenance mode is enabled
 * (or while the flag store is unreadable), together with all of their
 * descendants. Prefix matching is boundary-safe: only the exact path
 * or a "/"-suffixed descendant matches ("/api/admin" covers
 * "/api/admin/settings" but NOT "/api/administration").
 */
export const MAINTENANCE_EXEMPT_PREFIXES: ReadonlyArray<string> = [
  "/api/admin",
  "/api/webhooks/telegram",
  "/api/webhooks/whatsapp",
];

/*
 * Exemptions that apply to the EXACT path only — descendants stay
 * gated. Health checks and payment-provider webhooks register a single
 * fixed endpoint; unrelated nested paths below them must NOT bypass
 * maintenance mode.
 */
export const MAINTENANCE_EXEMPT_EXACT_PATHS: ReadonlyArray<string> = [
  "/api/health",
  "/api/billing/webhook",
];

export const MAINTENANCE_MODE_BODY = {
  code: "MAINTENANCE_MODE",
  message:
    "Hypnate is temporarily undergoing maintenance. Please try again later.",
} as const;

export const SERVICE_UNAVAILABLE_BODY = {
  code: "SERVICE_UNAVAILABLE",
  message: "Hypnate is temporarily unavailable. Please try again later.",
} as const;

export const REGISTRATION_DISABLED_BODY = {
  code: "REGISTRATION_DISABLED",
  message: "New user registrations are currently disabled.",
} as const;

/*
 * Exemption match: exact-path entries match only themselves; prefix
 * entries match the path itself or a "/"-boundary descendant.
 * Exported for tests.
 */
export function isMaintenanceExempt(path: string): boolean {
  if (MAINTENANCE_EXEMPT_EXACT_PATHS.includes(path)) {
    return true;
  }

  return MAINTENANCE_EXEMPT_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`)
  );
}

/*
 * The gated surface is the API: the path "/api" itself or any path
 * beginning with the "/api/" segment. A path like "/apiculture" merely
 * starting with the characters "/api" is NOT part of the API surface.
 * Exported for tests.
 */
export function isApiSurface(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

/* ----------------------------------------------------
   REGISTRATION GATE
---------------------------------------------------- */

export const createRegistrationFlagMiddleware = (
  flagsReader: FeatureFlagsReader = getFeatureFlags
) => {
  return async (
    _req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    let flags: FeatureFlags;

    try {
      flags = await flagsReader();
    } catch (err) {
      /*
       * Fail SAFE, not open: the flag state is unknown, so the request
       * is not waved through on the assumption registration is open.
       * The existing error handler decides the response (500), which
       * is retryable and never acknowledges the registration.
       */
      return next(err);
    }

    if (!flags.newUserRegistration) {
      return void res
        .status(403)
        .json({ ...REGISTRATION_DISABLED_BODY });
    }

    return next();
  };
};

export const requireRegistrationEnabled =
  createRegistrationFlagMiddleware();

/* ----------------------------------------------------
   MAINTENANCE MODE
---------------------------------------------------- */

export const createMaintenanceMiddleware = (
  flagsReader: FeatureFlagsReader = getFeatureFlags
) => {
  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    /*
     * CORS preflight must keep working in every mode. The cors
     * middleware runs earlier and handles OPTIONS; this guard also
     * keeps a preflight from being answered with 503 if it reaches us.
     */
    if (req.method === "OPTIONS") {
      return next();
    }

    const path = req.path ?? "";

    /*
     * Only the API surface is gated ("/api" itself or paths beginning
     * with the "/api/" segment). Static assets and non-API paths pass
     * through with unchanged behavior.
     */
    if (!isApiSurface(path)) {
      return next();
    }

    /*
     * Exempt paths skip the flag read entirely, so administrators can
     * always reach the panel and inbound webhooks keep flowing — both
     * while maintenance is ON and while the flag store is unreadable.
     */
    if (isMaintenanceExempt(path)) {
      return next();
    }

    let flags: FeatureFlags;

    try {
      flags = await flagsReader();
    } catch (err) {
      /*
       * Fail CLOSED: the maintenance state is unknown, so ordinary API
       * traffic must NOT be allowed through on the assumption that
       * maintenance is disabled. Respond 503 with a machine-readable
       * code; exempt paths never reach this branch.
       */
      logger.error(
        "Maintenance middleware: feature-flag read failed; failing closed",
        err
      );

      return void res
        .status(503)
        .json({ ...SERVICE_UNAVAILABLE_BODY });
    }

    if (flags.maintenanceMode) {
      return void res.status(503).json({ ...MAINTENANCE_MODE_BODY });
    }

    return next();
  };
};

export const maintenanceModeMiddleware =
  createMaintenanceMiddleware();
