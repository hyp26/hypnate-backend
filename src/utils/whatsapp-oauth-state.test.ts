import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import crypto from "crypto";
import {
  buildWhatsAppResultRedirectUrl,
  createOAuthState,
  DEFAULT_OAUTH_RETURN_TO,
  normalizeReturnTo,
  OAUTH_STATE_MAX_AGE,
  verifyOAuthState,
} from "./whatsapp-oauth-state";

const APP_SECRET = "unit-test-app-secret";
const FRONTEND_URL = "https://hypnate.in";

const craftState = (
  payload: Record<string, unknown>,
  secret: string = APP_SECRET
) => {
  const payloadEncoded = Buffer.from(
    JSON.stringify(payload),
    "utf8"
  ).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(payloadEncoded)
    .digest("base64url");
  return `${payloadEncoded}.${signature}`;
};

describe("normalizeReturnTo", () => {
  it("accepts only the two known return contexts", () => {
    assert.equal(normalizeReturnTo("onboarding"), "onboarding");
    assert.equal(normalizeReturnTo("settings"), "settings");
  });

  it("falls back to settings for missing or unknown values", () => {
    assert.equal(normalizeReturnTo(undefined), "settings");
    assert.equal(normalizeReturnTo("dashboard"), "settings");
    assert.equal(
      normalizeReturnTo("https://evil.example.com/onboarding"),
      "settings"
    );
    assert.equal(normalizeReturnTo(["onboarding"]), "settings");
  });
});

describe("createOAuthState / verifyOAuthState", () => {
  it("carries returnTo=onboarding through create and verify", () => {
    const now = Date.now();
    const state = createOAuthState(42, "onboarding", APP_SECRET);
    const verified = verifyOAuthState(state, APP_SECRET, now + 1000);
    assert.ok(verified);
    assert.equal(verified.sellerId, 42);
    assert.equal(verified.returnTo, "onboarding");
  });

  it("carries returnTo=settings through create and verify", () => {
    const state = createOAuthState(7, "settings", APP_SECRET);
    const verified = verifyOAuthState(state, APP_SECRET);
    assert.ok(verified);
    assert.equal(verified.sellerId, 7);
    assert.equal(verified.returnTo, "settings");
  });

  it("rejects a tampered state and a wrong app secret", () => {
    const state = createOAuthState(42, "settings", APP_SECRET);
    const [payloadEncoded, signature] = state.split(".");
    const payload = JSON.parse(
      Buffer.from(payloadEncoded, "base64url").toString("utf8")
    );
    // Attacker flips the signed return context without re-signing.
    payload.returnTo = "onboarding";
    const tamperedPayload = Buffer.from(
      JSON.stringify(payload),
      "utf8"
    ).toString("base64url");
    assert.equal(
      verifyOAuthState(`${tamperedPayload}.${signature}`, APP_SECRET),
      null
    );

    const forged = craftState(
      {
        sellerId: 1,
        returnTo: "onboarding",
        issuedAt: Date.now(),
        nonce: "x".repeat(32),
      },
      "wrong-secret"
    );
    assert.equal(verifyOAuthState(forged, APP_SECRET), null);
  });

  it("falls back to settings for legacy states without returnTo", () => {
    const legacy = craftState({
      sellerId: 5,
      issuedAt: Date.now(),
      nonce: "a".repeat(32),
    });
    const verified = verifyOAuthState(legacy, APP_SECRET);
    assert.ok(verified);
    assert.equal(verified.returnTo, DEFAULT_OAUTH_RETURN_TO);
  });

  it("normalizes an unknown signed returnTo back to settings", () => {
    const weird = craftState({
      sellerId: 5,
      returnTo: "https://evil.example.com",
      issuedAt: Date.now(),
      nonce: "a".repeat(32),
    });
    const verified = verifyOAuthState(weird, APP_SECRET);
    assert.ok(verified);
    assert.equal(verified.returnTo, "settings");
  });

  it("enforces the expiry window", () => {
    const now = Date.now();
    const state = createOAuthState(42, "onboarding", APP_SECRET);
    assert.equal(
      verifyOAuthState(state, APP_SECRET, now + OAUTH_STATE_MAX_AGE + 1),
      null
    );
    const stillValid = verifyOAuthState(
      state,
      APP_SECRET,
      now + OAUTH_STATE_MAX_AGE - 1
    );
    assert.ok(stillValid);
    assert.equal(stillValid.returnTo, "onboarding");
  });
});

describe("buildWhatsAppResultRedirectUrl", () => {
  it("sends onboarding success to /onboarding?wa=connected", () => {
    assert.equal(
      buildWhatsAppResultRedirectUrl(
        FRONTEND_URL,
        "connected",
        undefined,
        "onboarding"
      ),
      "https://hypnate.in/onboarding?wa=connected"
    );
  });

  it("sends settings success to /settings?wa=connected", () => {
    assert.equal(
      buildWhatsAppResultRedirectUrl(
        FRONTEND_URL,
        "connected",
        undefined,
        "settings"
      ),
      "https://hypnate.in/settings?wa=connected"
    );
  });

  it("sends onboarding failures to /onboarding?wa=error&reason=<safe-code>", () => {
    assert.equal(
      buildWhatsAppResultRedirectUrl(
        FRONTEND_URL,
        "error",
        "state_mismatch",
        "onboarding"
      ),
      "https://hypnate.in/onboarding?wa=error&reason=state_mismatch"
    );
  });

  it("sends settings failures to /settings?wa=error&reason=<safe-code>", () => {
    assert.equal(
      buildWhatsAppResultRedirectUrl(
        FRONTEND_URL,
        "error",
        "authorization_failed",
        "settings"
      ),
      "https://hypnate.in/settings?wa=error&reason=authorization_failed"
    );
  });

  it("defaults to the settings route when no return context is given", () => {
    assert.equal(
      buildWhatsAppResultRedirectUrl(FRONTEND_URL, "connected"),
      "https://hypnate.in/settings?wa=connected"
    );
  });
});
