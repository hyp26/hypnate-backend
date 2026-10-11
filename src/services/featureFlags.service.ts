import prisma from "../prisma/client";
import { logger } from "../utils/logger";

/*
 * P1-004 — Shared backend feature-flag service.
 *
 * Single source of truth for:
 * - the AdminSetting key the existing admin settings controller
 *   already uses ("featureFlags"),
 * - the default flag values (identical to the pre-existing defaults),
 * - normalization of stored values into a typed FeatureFlags object.
 *
 * The admin settings API (src/controllers/admin/adminSettings.controller.ts)
 * imports the key and defaults from HERE so the admin panel and the
 * runtime enforcement paths can never drift apart.
 *
 * Enforcement semantics:
 * - A missing settings record (or a non-object value) yields the
 *   defaults: maintenance DISABLED, registration ENABLED — exactly the
 *   pre-existing behavior.
 * - Partial or malformed stored values fall back per-flag to the
 *   defaults. Only real booleans are honored; no string/number
 *   coercion ("false", 0, ...) so a corrupted row cannot accidentally
 *   read as enabled or disabled.
 * - A database read FAILURE rejects: getFeatureFlags() NEVER returns
 *   defaults on error. Callers must fail safely (maintenance middleware
 *   responds 503 fail-closed; registration middleware forwards the
 *   error to the existing error handler). Silently failing open is
 *   explicitly forbidden.
 *
 * No caching: enforcement reads the persisted state on every request so
 * every Render instance observes an administrator's change immediately
 * and instances can never disagree.
 */

export const FEATURE_FLAGS_KEY = "featureFlags";

export const DEFAULT_FEATURE_FLAGS = {
  maintenanceMode: false,
  newUserRegistration: true,
  emailNotifications: true,
  analyticsDashboard: true,
  subscriptionUpgrades: true,
};

export interface FeatureFlags {
  maintenanceMode: boolean;
  newUserRegistration: boolean;
  emailNotifications: boolean;
  analyticsDashboard: boolean;
  subscriptionUpgrades: boolean;
}

const FEATURE_FLAG_KEYS = Object.keys(
  DEFAULT_FEATURE_FLAGS
) as Array<keyof FeatureFlags>;

/*
 * Pure normalization of a stored feature-flag value into typed flags.
 *
 * - Non-object / null values → all defaults.
 * - Known flags honor booleans only; anything else (string, number,
 *   null, nested object) falls back to that flag's default and logs a
 *   warning (flag name only — never the stored value).
 * - Unknown extra keys are ignored, not copied.
 * Exported for tests.
 */
export function normalizeFeatureFlags(
  raw: unknown
): FeatureFlags {
  const flags: FeatureFlags = { ...DEFAULT_FEATURE_FLAGS };

  if (typeof raw !== "object" || raw === null) {
    return flags;
  }

  const record = raw as Record<string, unknown>;

  for (const key of FEATURE_FLAG_KEYS) {
    const value = record[key];

    if (typeof value === "boolean") {
      flags[key] = value;
    } else if (value !== undefined) {
      logger.warn(
        "FeatureFlags: malformed stored value; using default",
        { key }
      );
    }
  }

  return flags;
}

/*
 * The persisted AdminSetting row for feature flags (or null when no
 * record exists). Injectable so tests can supply stored values
 * without a database.
 */
export type FeatureFlagSettingRow = { value: unknown } | null;

export async function queryFeatureFlagSetting(): Promise<FeatureFlagSettingRow> {
  const row = await prisma.adminSetting.findUnique({
    where: { key: FEATURE_FLAGS_KEY },
  });

  return row;
}

/*
 * Effective feature flags.
 *
 * The default reader is the shared Prisma client; a database failure
 * PROPAGATES as a rejected promise — this function never fabricates
 * defaults on error. The maintenance middleware catches that
 * rejection and fails closed (503); the registration middleware
 * forwards it to the existing error handler.
 * Exported for middleware, controllers, and tests.
 */
export async function getFeatureFlags(
  querySetting: () => Promise<FeatureFlagSettingRow> = queryFeatureFlagSetting
): Promise<FeatureFlags> {
  const row = await querySetting();

  return normalizeFeatureFlags(row ? row.value : null);
}
