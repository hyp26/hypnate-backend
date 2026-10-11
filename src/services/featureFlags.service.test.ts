import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  DEFAULT_FEATURE_FLAGS,
  FEATURE_FLAGS_KEY,
  getFeatureFlags,
  normalizeFeatureFlags,
} from "./featureFlags.service";

/*
 * All tests inject the setting reader, so no database is required.
 * The default reader (queryFeatureFlagSetting → prisma) is exercised
 * only in production wiring; its DB-failure behavior is covered by
 * the injected-rejection tests below (getFeatureFlags never catches).
 */

const readerReturning = (value: unknown) => async () => ({
  value,
});

const missingReader = async () => null;

describe("normalizeFeatureFlags", () => {
  it("returns all defaults for a non-object value", () => {
    assert.deepEqual(normalizeFeatureFlags(null), DEFAULT_FEATURE_FLAGS);
    assert.deepEqual(normalizeFeatureFlags(undefined), DEFAULT_FEATURE_FLAGS);
    assert.deepEqual(normalizeFeatureFlags("featureFlags"), DEFAULT_FEATURE_FLAGS);
    assert.deepEqual(normalizeFeatureFlags(42), DEFAULT_FEATURE_FLAGS);
  });

  it("returns all defaults for an empty object", () => {
    assert.deepEqual(normalizeFeatureFlags({}), DEFAULT_FEATURE_FLAGS);
  });

  it("honors stored boolean values for every known flag", () => {
    const flags = normalizeFeatureFlags({
      maintenanceMode: true,
      newUserRegistration: false,
      emailNotifications: false,
      analyticsDashboard: false,
      subscriptionUpgrades: false,
    });

    assert.deepEqual(flags, {
      maintenanceMode: true,
      newUserRegistration: false,
      emailNotifications: false,
      analyticsDashboard: false,
      subscriptionUpgrades: false,
    });
  });

  it("keeps defaults for flags omitted from a partial stored record", () => {
    const flags = normalizeFeatureFlags({
      maintenanceMode: true,
    });

    assert.equal(flags.maintenanceMode, true);
    assert.equal(flags.newUserRegistration, true);
    assert.equal(flags.emailNotifications, true);
    assert.equal(flags.analyticsDashboard, true);
    assert.equal(flags.subscriptionUpgrades, true);
  });

  it("falls back per-flag to defaults for malformed stored values", () => {
    const flags = normalizeFeatureFlags({
      maintenanceMode: "false",        // string, not boolean → default
      newUserRegistration: 0,          // number → default
      emailNotifications: null,        // null → default
      analyticsDashboard: { on: 1 },  // object → default
      subscriptionUpgrades: "true",   // string, not boolean → default
    });

    assert.deepEqual(flags, DEFAULT_FEATURE_FLAGS);
  });

  it("never coerces malformed values into an enabled or disabled state", () => {
    // A corrupted row must not read as "maintenance off" via coercion.
    const flags = normalizeFeatureFlags({ maintenanceMode: "false" });

    assert.equal(flags.maintenanceMode, DEFAULT_FEATURE_FLAGS.maintenanceMode);
  });

  it("ignores unknown extra keys instead of copying them", () => {
    const flags = normalizeFeatureFlags({
      maintenanceMode: true,
      superuserBypass: true,
      nested: { deep: true },
    });

    assert.equal(flags.maintenanceMode, true);
    assert.equal(
      (flags as Record<string, unknown>).superuserBypass,
      undefined
    );
  });
});

describe("getFeatureFlags (injected reader)", () => {
  it("returns normalized flags for an existing stored record", async () => {
    const flags = await getFeatureFlags(
      readerReturning({
        maintenanceMode: true,
        newUserRegistration: false,
      })
    );

    assert.equal(flags.maintenanceMode, true);
    assert.equal(flags.newUserRegistration, false);
    assert.equal(flags.emailNotifications, true);
  });

  it("returns defaults when the settings record is missing", async () => {
    const flags = await getFeatureFlags(missingReader);

    assert.deepEqual(flags, DEFAULT_FEATURE_FLAGS);
    // Documented missing-record behavior: maintenance off,
    // registration open.
    assert.equal(flags.maintenanceMode, false);
    assert.equal(flags.newUserRegistration, true);
  });

  it("returns defaults when the stored value is not an object", async () => {
    const flags = await getFeatureFlags(readerReturning("corrupted"));

    assert.deepEqual(flags, DEFAULT_FEATURE_FLAGS);
  });

  it("normalizes partial stored records against the defaults", async () => {
    const flags = await getFeatureFlags(
      readerReturning({ newUserRegistration: false })
    );

    assert.equal(flags.newUserRegistration, false);
    assert.equal(flags.maintenanceMode, false);
  });

  it("REJECTS when the database read fails — never fails open", async () => {
    const failingReader = async () => {
      throw new Error("connection refused");
    };

    await assert.rejects(
      () => getFeatureFlags(failingReader),
      /connection refused/
    );
  });

  it("uses the same AdminSetting key as the admin settings controller", () => {
    // The service and the admin API must read/write the same record.
    assert.equal(FEATURE_FLAGS_KEY, "featureFlags");
  });
});
