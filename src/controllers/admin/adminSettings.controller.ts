import { Request, Response, NextFunction } from "express";
import { Prisma } from "@prisma/client";
import prisma from "../../prisma/client";
import { AdminAuthRequest } from "../../middleware/adminAuth.middleware";
import {
  adminSettingsSchema,
  featureFlagsSchema,
} from "../../schemas/admin.schemas";
import { recordAudit } from "../../services/adminAudit.service";

/* ----------------------------------------------------
   SETTINGS STORAGE
---------------------------------------------------- */

const SETTINGS_KEY = "general";
const FEATURE_FLAGS_KEY = "featureFlags";

const DEFAULT_SETTINGS = {
  siteName: "Hypnate Admin",
  siteDescription: "Internal administration panel for Hypnate",
  logoUrl: "/logo.svg",
  faviconUrl: "/favicon.ico",
  defaultCurrency: "USD",
  defaultTimezone: "UTC",
  supportEmail: "support@hypnate.in",
};

const DEFAULT_FEATURE_FLAGS = {
  maintenanceMode: false,
  newUserRegistration: true,
  emailNotifications: true,
  analyticsDashboard: true,
  subscriptionUpgrades: true,
};

const getSetting = async (
  key: string,
  fallback: Record<string, unknown>
): Promise<Record<string, unknown>> => {
  const row = await prisma.adminSetting.findUnique({
    where: { key },
  });

  if (!row || typeof row.value !== "object" || row.value === null) {
    return { ...fallback };
  }

  return { ...fallback, ...(row.value as Record<string, unknown>) };
};

const saveSetting = async (
  key: string,
  value: Record<string, unknown>
): Promise<void> => {
  const existing = await prisma.adminSetting.findUnique({
    where: { key },
    select: { id: true },
  });

  if (existing) {
    await prisma.adminSetting.update({
      where: { id: existing.id },
      data: { value: value as Prisma.InputJsonValue },
    });
  } else {
    await prisma.adminSetting.create({
      data: { key, value: value as Prisma.InputJsonValue },
    });
  }
};

/* ----------------------------------------------------
   GET /api/admin/settings
---------------------------------------------------- */

export const getSettings = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const [general, featureFlags] = await Promise.all([
      getSetting(SETTINGS_KEY, DEFAULT_SETTINGS),
      getSetting(FEATURE_FLAGS_KEY, DEFAULT_FEATURE_FLAGS),
    ]);

    res.json({ settings: { ...general, featureFlags } });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   PUT /api/admin/settings
---------------------------------------------------- */

export const updateSettings = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const parsed = adminSettingsSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        message: parsed.error.issues[0]?.message ?? "Invalid request",
      });
      return;
    }

    const current = await getSetting(SETTINGS_KEY, DEFAULT_SETTINGS);
    const next = { ...current, ...parsed.data };

    await saveSetting(SETTINGS_KEY, next);

    await recordAudit({
      actorId: req.adminUser!.id,
      action: "SETTINGS",
      entityType: "AdminSetting",
      entityId: SETTINGS_KEY,
      oldValue: current,
      newValue: next,
      req,
    });

    const featureFlags = await getSetting(
      FEATURE_FLAGS_KEY,
      DEFAULT_FEATURE_FLAGS
    );

    res.json({ settings: { ...next, featureFlags } });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   GET /api/admin/feature-flags
---------------------------------------------------- */

export const getFeatureFlags = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const featureFlags = await getSetting(
      FEATURE_FLAGS_KEY,
      DEFAULT_FEATURE_FLAGS
    );

    res.json({ featureFlags });
  } catch (err) {
    next(err);
  }
};

/* ----------------------------------------------------
   PUT /api/admin/feature-flags
---------------------------------------------------- */

export const updateFeatureFlags = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const parsed = featureFlagsSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        message: parsed.error.issues[0]?.message ?? "Invalid request",
      });
      return;
    }

    const current = await getSetting(
      FEATURE_FLAGS_KEY,
      DEFAULT_FEATURE_FLAGS
    );

    const next = { ...current, ...parsed.data };

    await saveSetting(FEATURE_FLAGS_KEY, next);

    await recordAudit({
      actorId: req.adminUser!.id,
      action: "SETTINGS",
      entityType: "AdminSetting",
      entityId: FEATURE_FLAGS_KEY,
      oldValue: current,
      newValue: next,
      req,
    });

    res.json({ featureFlags: next });
  } catch (err) {
    next(err);
  }
};
