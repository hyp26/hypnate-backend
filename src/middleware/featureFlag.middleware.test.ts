import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  createMaintenanceMiddleware,
  createRegistrationFlagMiddleware,
  isApiSurface,
  isMaintenanceExempt,
  MAINTENANCE_MODE_BODY,
  REGISTRATION_DISABLED_BODY,
  SERVICE_UNAVAILABLE_BODY,
} from "./featureFlag.middleware";

/*
 * These tests exercise the ACTUAL middleware decision functions with
 * mock req/res/next objects and injected flag readers — no string
 * searches, no database.
 */

interface MockRes {
  statusCode: number;
  body: unknown;
  status(code: number): MockRes;
  json(payload: unknown): MockRes;
}

const makeRes = (): MockRes => {
  const res: MockRes = {
    statusCode: 0,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };

  return res;
};

interface MockReq {
  method: string;
  path: string;
  body?: unknown;
}

const makeReq = (
  method: string,
  path: string,
  body?: unknown
): MockReq => ({ method, path, body });

const flags = (overrides: Record<string, boolean> = {}) => ({
  maintenanceMode: false,
  newUserRegistration: true,
  emailNotifications: true,
  analyticsDashboard: true,
  subscriptionUpgrades: true,
  ...overrides,
});

const enabledReader = async () => flags();
const maintenanceReader = async () =>
  flags({ maintenanceMode: true });
const failingReader = async () => {
  throw new Error("flag store unreachable");
};

/*
 * Drive one middleware decision and return what happened:
 * either the middleware called next() (passthrough), forwarded an
 * error to next(err), or wrote a status + body.
 */
const drive = async (
  middleware: (req: any, res: any, next: any) => Promise<void> | void,
  req: MockReq
): Promise<
  | { outcome: "next" }
  | { outcome: "next_error"; error: unknown }
  | { outcome: "responded"; statusCode: number; body: unknown }
> => {
  const res = makeRes();

  let nextCalled = false;
  let nextError: unknown = undefined;

  const next = (err?: unknown) => {
    nextCalled = true;
    nextError = err;
  };

  await middleware(req as any, res as any, next as any);

  if (nextCalled) {
    return nextError === undefined
      ? { outcome: "next" }
      : { outcome: "next_error", error: nextError };
  }

  return { outcome: "responded", statusCode: res.statusCode, body: res.body };
};

/* ----------------------------------------------------
   EXEMPTION MATCHING
---------------------------------------------------- */

describe("isMaintenanceExempt", () => {
  it("matches the exact exempt paths", () => {
    assert.equal(isMaintenanceExempt("/api/admin"), true);
    assert.equal(isMaintenanceExempt("/api/health"), true);
    assert.equal(isMaintenanceExempt("/api/webhooks/telegram"), true);
    assert.equal(isMaintenanceExempt("/api/webhooks/whatsapp"), true);
    assert.equal(isMaintenanceExempt("/api/billing/webhook"), true);
  });

  it("matches descendants of prefix-exempt paths", () => {
    assert.equal(isMaintenanceExempt("/api/admin/settings"), true);
    assert.equal(isMaintenanceExempt("/api/admin/auth/login"), true);
    assert.equal(isMaintenanceExempt("/api/admin/feature-flags"), true);
    assert.equal(isMaintenanceExempt("/api/webhooks/telegram/1"), true);
    assert.equal(isMaintenanceExempt("/api/webhooks/whatsapp/12"), true);
  });

  it("does NOT exempt descendants of exact-path exemptions", () => {
    assert.equal(isMaintenanceExempt("/api/health/anything"), false);
    assert.equal(
      isMaintenanceExempt("/api/billing/webhook/anything"),
      false
    );
  });

  it("does NOT whitelist unrelated near-miss paths", () => {
    assert.equal(isMaintenanceExempt("/api/messages/send"), false);
    assert.equal(isMaintenanceExempt("/api/billing/plans"), false);
    assert.equal(isMaintenanceExempt("/api/billing/webhooks"), false);
    assert.equal(isMaintenanceExempt("/api/administration"), false);
    assert.equal(isMaintenanceExempt("/api/healthy"), false);
    assert.equal(isMaintenanceExempt("/api/products"), false);
    assert.equal(isMaintenanceExempt("/api/auth/register"), false);
  });
});

/* ----------------------------------------------------
   API-SURFACE BOUNDARY
---------------------------------------------------- */

describe("isApiSurface", () => {
  it("gates '/api' itself and paths under the '/api/' segment", () => {
    assert.equal(isApiSurface("/api"), true);
    assert.equal(isApiSurface("/api/products"), true);
  });

  it("does NOT treat mere character-prefix lookalikes as API paths", () => {
    assert.equal(isApiSurface("/apiculture"), false);
    assert.equal(isApiSurface("/apiary"), false);
    assert.equal(isApiSurface("/uploads/logo.svg"), false);
  });
});

/* ----------------------------------------------------
   MAINTENANCE MIDDLEWARE
---------------------------------------------------- */

describe("maintenance middleware decisions", () => {
  const maintenance = createMaintenanceMiddleware(maintenanceReader);
  const off = createMaintenanceMiddleware(enabledReader);
  const failClosed = createMaintenanceMiddleware(failingReader);

  it("enabled mode blocks a representative user-facing route with 503", async () => {
    const result = await drive(maintenance, makeReq("GET", "/api/products"));

    assert.equal(result.outcome, "responded");
    assert.equal(result.statusCode, 503);
    assert.deepEqual(result.body, { ...MAINTENANCE_MODE_BODY });
  });

  it("enabled mode blocks other user-facing routes (orders, auth, messages)", async () => {
    for (const path of [
      "/api/orders",
      "/api/auth/login",
      "/api/messages/send",
      "/api/conversations",
      "/api/billing/plans",
    ]) {
      const result = await drive(maintenance, makeReq("POST", path));

      assert.equal(result.outcome, "responded", path);
      assert.equal(result.statusCode, 503, path);
    }
  });

  it("enabled mode blocks the '/api' root itself", async () => {
    const result = await drive(maintenance, makeReq("GET", "/api"));

    assert.equal(result.outcome, "responded");
    assert.equal(result.statusCode, 503);
  });

  it("disabled mode calls next() with unchanged behavior", async () => {
    const result = await drive(off, makeReq("GET", "/api/products"));

    assert.equal(result.outcome, "next");
  });

  it("admin routes and admin login remain accessible in maintenance mode", async () => {
    const login = await drive(
      maintenance,
      makeReq("POST", "/api/admin/auth/login")
    );
    const settings = await drive(
      maintenance,
      makeReq("PUT", "/api/admin/feature-flags")
    );
    const panel = await drive(
      maintenance,
      makeReq("GET", "/api/admin/settings")
    );

    assert.equal(login.outcome, "next");
    assert.equal(settings.outcome, "next");
    assert.equal(panel.outcome, "next");
  });

  it("/api/health remains accessible in maintenance mode", async () => {
    const result = await drive(maintenance, makeReq("GET", "/api/health"));

    assert.equal(result.outcome, "next");
  });

  it("Telegram and WhatsApp webhook routes remain accessible", async () => {
    const telegram = await drive(
      maintenance,
      makeReq("POST", "/api/webhooks/telegram/1")
    );
    const whatsapp = await drive(
      maintenance,
      makeReq("POST", "/api/webhooks/whatsapp")
    );

    assert.equal(telegram.outcome, "next");
    assert.equal(whatsapp.outcome, "next");
  });

  it("descendants of the webhook exemptions remain accessible", async () => {
    const telegram = await drive(
      maintenance,
      makeReq("POST", "/api/webhooks/telegram/12345")
    );
    const whatsapp = await drive(
      maintenance,
      makeReq("POST", "/api/webhooks/whatsapp/98765/status")
    );

    assert.equal(telegram.outcome, "next");
    assert.equal(whatsapp.outcome, "next");
  });

  it("the payment-provider billing webhook remains accessible", async () => {
    const result = await drive(
      maintenance,
      makeReq("POST", "/api/billing/webhook")
    );

    assert.equal(result.outcome, "next");
  });

  it("descendants of /api/billing/webhook are NOT exempt", async () => {
    const result = await drive(
      maintenance,
      makeReq("POST", "/api/billing/webhook/anything")
    );

    assert.equal(result.outcome, "responded");
    assert.equal(result.statusCode, 503);
    assert.deepEqual(result.body, { ...MAINTENANCE_MODE_BODY });
  });

  it("descendants of /api/health are NOT exempt", async () => {
    const result = await drive(
      maintenance,
      makeReq("GET", "/api/health/anything")
    );

    assert.equal(result.outcome, "responded");
    assert.equal(result.statusCode, 503);
    assert.deepEqual(result.body, { ...MAINTENANCE_MODE_BODY });
  });

  it("other /api/billing routes are NOT whitelisted", async () => {
    const plans = await drive(maintenance, makeReq("GET", "/api/billing/plans"));
    const subscription = await drive(
      maintenance,
      makeReq("GET", "/api/billing/subscription")
    );

    assert.equal(plans.outcome, "responded");
    assert.equal(plans.statusCode, 503);
    assert.equal(subscription.outcome, "responded");
    assert.equal(subscription.statusCode, 503);
  });

  it("the legacy /api/messages/send route is NOT whitelisted", async () => {
    const result = await drive(
      maintenance,
      makeReq("POST", "/api/messages/send")
    );

    assert.equal(result.outcome, "responded");
    assert.equal(result.statusCode, 503);
  });

  it("OPTIONS preflight passes through even in maintenance mode", async () => {
    const result = await drive(
      maintenance,
      makeReq("OPTIONS", "/api/products")
    );

    assert.equal(result.outcome, "next");
  });

  it("OPTIONS passes through even when the flag read would fail", async () => {
    const result = await drive(
      failClosed,
      makeReq("OPTIONS", "/api/products")
    );

    assert.equal(result.outcome, "next");
  });

  it("non-API paths (static assets) are not gated", async () => {
    const result = await drive(
      maintenance,
      makeReq("GET", "/uploads/logo.svg")
    );

    assert.equal(result.outcome, "next");
  });

  it("fails CLOSED with 503 when the flag read fails", async () => {
    const result = await drive(failClosed, makeReq("GET", "/api/products"));

    assert.equal(result.outcome, "responded");
    assert.equal(result.statusCode, 503);
    assert.deepEqual(result.body, { ...SERVICE_UNAVAILABLE_BODY });
  });

  it("non-exempt descendants of exact-path exemptions fail CLOSED too", async () => {
    const healthChild = await drive(
      failClosed,
      makeReq("GET", "/api/health/anything")
    );
    const billingChild = await drive(
      failClosed,
      makeReq("POST", "/api/billing/webhook/anything")
    );

    assert.equal(healthChild.outcome, "responded");
    assert.equal(healthChild.statusCode, 503);
    assert.deepEqual(healthChild.body, { ...SERVICE_UNAVAILABLE_BODY });
    assert.equal(billingChild.outcome, "responded");
    assert.equal(billingChild.statusCode, 503);
    assert.deepEqual(billingChild.body, { ...SERVICE_UNAVAILABLE_BODY });
  });

  it("exempt admin and webhook paths remain reachable when the flag read fails", async () => {
    const admin = await drive(
      failClosed,
      makeReq("POST", "/api/admin/auth/login")
    );
    const health = await drive(failClosed, makeReq("GET", "/api/health"));
    const telegram = await drive(
      failClosed,
      makeReq("POST", "/api/webhooks/telegram/1")
    );
    const whatsapp = await drive(
      failClosed,
      makeReq("POST", "/api/webhooks/whatsapp")
    );
    const billing = await drive(
      failClosed,
      makeReq("POST", "/api/billing/webhook")
    );

    // Exempt paths skip the flag read entirely, so they never observe
    // the failure.
    assert.equal(admin.outcome, "next");
    assert.equal(health.outcome, "next");
    assert.equal(telegram.outcome, "next");
    assert.equal(whatsapp.outcome, "next");
    assert.equal(billing.outcome, "next");
  });

  it("'/apiculture' is not treated as part of the /api surface", async () => {
    // Using the failing reader proves the middleware never performs a
    // flag read for this path — it is outside the gated API surface,
    // so it passes through even while the flag store is unreadable.
    const result = await drive(failClosed, makeReq("GET", "/apiculture"));

    assert.equal(result.outcome, "next");
  });
});

/* ----------------------------------------------------
   REGISTRATION GATE
---------------------------------------------------- */

describe("registration flag middleware decisions", () => {
  const disabled = createRegistrationFlagMiddleware(
    async () => flags({ newUserRegistration: false })
  );
  const enabled = createRegistrationFlagMiddleware(enabledReader);
  const failSafe = createRegistrationFlagMiddleware(failingReader);

  it("disabled registration returns 403 with the documented machine-readable code", async () => {
    const result = await drive(
      disabled,
      makeReq("POST", "/api/auth/register", {
        name: "Aisha",
        email: "aisha@example.com",
        password: "Str0ng!pass",
      })
    );

    assert.equal(result.outcome, "responded");
    assert.equal(result.statusCode, 403);
    assert.deepEqual(result.body, { ...REGISTRATION_DISABLED_BODY });
  });

  it("disabled registration never calls next(), so the register controller (and all account-creation side effects) cannot run", async () => {
    const result = await drive(
      disabled,
      makeReq("POST", "/api/auth/register", {
        name: "Aisha",
        email: "aisha@example.com",
        password: "Str0ng!pass",
        businessName: "Aisha Threads",
        phone: "+911234567890",
      })
    );

    assert.equal(result.outcome, "responded");
    assert.equal(result.statusCode, 403);
  });

  it("enabled registration calls next() (existing path preserved)", async () => {
    const result = await drive(
      enabled,
      makeReq("POST", "/api/auth/register", {
        name: "Aisha",
        email: "aisha@example.com",
        password: "Str0ng!pass",
      })
    );

    assert.equal(result.outcome, "next");
  });

  it("does not trust a flag value provided by the request body", async () => {
    // Backend flags say enabled; the client claims disabled.
    // The stored backend value is authoritative → next().
    const result = await drive(
      enabled,
      makeReq("POST", "/api/auth/register", {
        newUserRegistration: false,
      })
    );

    assert.equal(result.outcome, "next");
  });

  it("forwards flag-read failures to the error handler instead of failing open", async () => {
    const result = await drive(
      failSafe,
      makeReq("POST", "/api/auth/register")
    );

    assert.equal(result.outcome, "next_error");
    assert.ok(result.outcome === "next_error");
  });
});
