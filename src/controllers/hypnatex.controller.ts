import { Response, NextFunction } from "express";
import axios from "axios";
import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";
import { logger } from "../utils/logger";
import { ENV } from "../config/env";

const PYTHON_WORKER_URL = ENV.PYTHON_WORKER_URL as string;
const INTERNAL_API_KEY  = ENV.INTERNAL_API_KEY as string;

/* ─────────────────────────────────────────────
   HELPER — URL-safe slug
───────────────────────────────────────────── */
const makeSlug = (name: string): string =>
  name.toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");

/* ─────────────────────────────────────────────
   GET /api/hypnate-x/themes
───────────────────────────────────────────── */
export const listThemes = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const themes = await (prisma as any).theme.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
    });
    return res.json(themes);
  } catch (err) {
    next(err);
  }
};

/* ─────────────────────────────────────────────
   POST /api/hypnate-x/build
───────────────────────────────────────────── */
export const startBuild = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { themeId, storeName, logoUrl } = req.body;
    const sellerId = req.user?.sellerId;

    if (!sellerId) {
      return res.status(400).json({ message: "Seller account required to build a store" });
    }
    if (!themeId || !storeName) {
      return res.status(400).json({ message: "themeId and storeName are required" });
    }
    if (storeName.trim().length < 2 || storeName.trim().length > 60) {
      return res.status(400).json({ message: "Store name must be between 2 and 60 characters" });
    }

    // Validate theme
    const theme = await (prisma as any).theme.findUnique({ where: { id: themeId } });
    if (!theme) {
      return res.status(404).json({ message: "Theme not found" });
    }

    // Generate unique slug
    let slug = makeSlug(storeName);
    const existing = await (prisma as any).store.findUnique({ where: { slug } });
    if (existing && existing.sellerId !== sellerId) {
      slug = `${slug}-${sellerId}`;
    }

    // Block if build already in progress
    const activeJob = await (prisma as any).buildJob.findFirst({
      where: {
        sellerId,
        status: { notIn: ["DONE", "FAILED"] },
      },
    });
    if (activeJob) {
      return res.status(409).json({
        message: "A build is already in progress",
        jobId: activeJob.id,
      });
    }

    // Fetch product catalog (snapshot at build time)
    const products = await prisma.product.findMany({
      where: { sellerId },
      select: { id: true, name: true, description: true, category: true, price: true, stock: true, imageUrl: true },
      take: 100,
    });

    const seller = await prisma.seller.findUnique({
      where: { id: sellerId },
      select: { businessName: true, phone: true },
    });

    // Upsert Store
    const store = await (prisma as any).store.upsert({
      where: { slug },
      create: { sellerId, themeId, storeName: storeName.trim(), slug, logoUrl: logoUrl || null, status: "BUILDING" },
      update: { themeId, storeName: storeName.trim(), logoUrl: logoUrl || null, status: "BUILDING", publishedAt: null },
    });

    // Create BuildJob
    const buildJob = await (prisma as any).buildJob.create({
      data: {
        storeId: store.id,
        sellerId,
        themeId,
        storeName: storeName.trim(),
        logoUrl: logoUrl || null,
        status: "QUEUED",
        currentStep: "Queued — waiting for worker",
        catalogJson: products,
        startedAt: new Date(),
      },
    });

    // Fire-and-forget to Python worker
    triggerPythonWorker(buildJob.id, {
      jobId: buildJob.id,
      storeId: store.id,
      sellerId,
      themeId,
      themeName: theme.name,
      themeCategory: theme.category,
      storeName: storeName.trim(),
      logoUrl: logoUrl || null,
      slug,
      products,
      seller,
    }).catch((err) => {
      logger.error(`[HypnateX] Worker trigger failed for job ${buildJob.id}:`, err.message);
      (prisma as any).buildJob.update({
        where: { id: buildJob.id },
        data: { status: "FAILED", errorMsg: "Worker service unavailable: " + err.message },
      }).catch(logger.error);
    });

    return res.status(202).json({
      message: "Build started",
      jobId: buildJob.id,
      storeId: store.id,
      slug,
      storeUrl: `https://${slug}.hypnate.in`,
    });
  } catch (err) {
    next(err);
  }
};

/* ─────────────────────────────────────────────
   GET /api/hypnate-x/status/:jobId
───────────────────────────────────────────── */
export const getBuildStatus = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const jobId    = parseInt(req.params.jobId);
    const sellerId = req.user?.sellerId;

    const job = await (prisma as any).buildJob.findUnique({
      where: { id: jobId },
      include: {
        store: { select: { slug: true, status: true, customDomain: true } },
      },
    });

    if (!job) return res.status(404).json({ message: "Build job not found" });
    if (job.sellerId !== sellerId) return res.status(403).json({ message: "Forbidden" });

    // Extract log messages from buildLog JSON array
    const buildLog = Array.isArray(job.buildLog) ? job.buildLog as any[] : [];
    const logs = buildLog.map((entry: any) =>
      typeof entry === "string" ? entry : entry.message || ""
    ).filter(Boolean);

    return res.json({
      jobId:       job.id,
      status:      job.status,
      currentStep: job.currentStep,
      error:       job.errorMsg,
      siteUrl:     job.deployedUrl || (job.store?.slug ? `https://${job.store.slug}.hypnate.in` : null),
      logs,
      startedAt:   job.startedAt,
      completedAt: job.completedAt,
    });
  } catch (err) {
    next(err);
  }
};

/* ─────────────────────────────────────────────
   GET /api/hypnate-x/store
───────────────────────────────────────────── */
export const getMyStore = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = req.user?.sellerId;
    if (!sellerId) return res.status(400).json({ message: "Seller account required" });

    const store = await (prisma as any).store.findFirst({
      where: { sellerId },
      include: {
        theme: true,
        buildJobs: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { id: true, status: true, currentStep: true, deployedUrl: true, completedAt: true },
        },
      },
    });

    if (!store) return res.status(404).json({ message: "No store found. Start a build first." });

    return res.json({
      ...store,
      storeUrl: `https://${store.slug}.hypnate.in`,
      latestJob: store.buildJobs[0] || null,
    });
  } catch (err) {
    next(err);
  }
};

/* ─────────────────────────────────────────────
   PUT /api/hypnate-x/store
───────────────────────────────────────────── */
export const updateStore = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = req.user?.sellerId;
    if (!sellerId) return res.status(400).json({ message: "Seller account required" });

    const { storeName, customDomain, logoUrl } = req.body;

    const store = await (prisma as any).store.findFirst({ where: { sellerId } });
    if (!store) return res.status(404).json({ message: "No store found" });

    const data: any = {};
    if (storeName) data.storeName = storeName.trim();
    if (logoUrl)   data.logoUrl   = logoUrl;
    if (customDomain !== undefined) {
      const domainRegex = /^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z]{2,}$/;
      if (customDomain && !domainRegex.test(customDomain)) {
        return res.status(400).json({ message: "Invalid domain format" });
      }
      data.customDomain = customDomain || null;
    }

    const updated = await (prisma as any).store.update({ where: { id: store.id }, data });
    return res.json(updated);
  } catch (err) {
    next(err);
  }
};

/* ─────────────────────────────────────────────
   INTERNAL — trigger Python worker
───────────────────────────────────────────── */
const triggerPythonWorker = async (jobId: number, payload: object) => {
  await axios.post(`${PYTHON_WORKER_URL}/build`, payload, {
    timeout: 30000, // 30s — worker may be waking up on free tier
    headers: {
      "Content-Type": "application/json",
      "x-internal-key": INTERNAL_API_KEY, // ✅ matches hypnatex.internal.routes.ts
    },
  });
  
  logger.info("HypnateX job dispatched to worker", {
  jobId,
});
};