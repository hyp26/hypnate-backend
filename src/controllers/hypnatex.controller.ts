import { Response, NextFunction } from "express";
import axios from "axios";
import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";

const PYTHON_WORKER_URL = process.env.PYTHON_WORKER_URL as string; // e.g. http://localhost:8000

/* ─────────────────────────────────────────────
   HELPER — generate URL-safe slug from store name
   e.g. "Sameer CS" → "sameer-cs"
───────────────────────────────────────────── */
const makeSlug = (name: string): string =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");

/* ─────────────────────────────────────────────
   GET /api/hypnate-x/themes
   Returns all active themes
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
   Body: { themeId, storeName, logoUrl? }

   Flow:
   1. Validate inputs
   2. Check seller doesn't already have a live store
   3. Fetch seller's product catalog
   4. Create/update Store record
   5. Create BuildJob record (status=QUEUED)
   6. Fire-and-forget to Python worker
   7. Return { jobId, storeId } immediately
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

    // Validate theme exists
    const theme = await (prisma as any).theme.findUnique({ where: { id: themeId } });
    if (!theme) {
      return res.status(404).json({ message: "Theme not found" });
    }

    // Validate store name length
    if (storeName.trim().length < 2 || storeName.trim().length > 60) {
      return res.status(400).json({ message: "Store name must be between 2 and 60 characters" });
    }

    // Generate slug and check uniqueness
    let slug = makeSlug(storeName);
    const existing = await (prisma as any).store.findUnique({ where: { slug } });
    if (existing && existing.sellerId !== sellerId) {
      // Slug taken by another seller — append seller id
      slug = `${slug}-${sellerId}`;
    }

    // Fetch seller's product catalog (snapshot at build time)
    const products = await prisma.product.findMany({
      where: { sellerId },
      select: {
        id: true,
        name: true,
        description: true,
        category: true,
        price: true,
        stock: true,
        imageUrl: true,
      },
      take: 100, // cap at 100 products for AI context
    });

    // Upsert Store record
    const store = await (prisma as any).store.upsert({
      where: { slug },
      create: {
        sellerId,
        themeId,
        storeName: storeName.trim(),
        slug,
        logoUrl: logoUrl || null,
        status: "BUILDING",
      },
      update: {
        themeId,
        storeName: storeName.trim(),
        logoUrl: logoUrl || null,
        status: "BUILDING",
        publishedAt: null,
      },
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
      },
    });

    // Fire-and-forget to Python worker (non-blocking)
    triggerPythonWorker(buildJob.id, {
      jobId: buildJob.id,
      storeId: store.id,
      sellerId,
      themeId,
      storeName: storeName.trim(),
      logoUrl: logoUrl || null,
      slug,
      products,
    }).catch((err) => {
      console.error(`[HypnateX] Worker trigger failed for job ${buildJob.id}:`, err.message);
      // Mark job as failed if worker unreachable
      (prisma as any).buildJob.update({
        where: { id: buildJob.id },
        data: { status: "FAILED", errorMsg: "Worker service unavailable" },
      });
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
   Frontend polls this every 3 seconds
───────────────────────────────────────────── */
export const getBuildStatus = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const jobId = parseInt(req.params.jobId);
    const sellerId = req.user?.sellerId;

    const job = await (prisma as any).buildJob.findUnique({
      where: { id: jobId },
      include: {
        store: {
          select: {
            slug: true,
            status: true,
            customDomain: true,
          },
        },
      },
    });

    if (!job) {
      return res.status(404).json({ message: "Build job not found" });
    }

    // Sellers can only see their own jobs
    if (job.sellerId !== sellerId) {
      return res.status(403).json({ message: "Forbidden" });
    }

    return res.json({
      jobId: job.id,
      status: job.status,
      currentStep: job.currentStep,
      errorMsg: job.errorMsg,
      deployedUrl: job.deployedUrl,
      storeUrl: job.store?.slug ? `https://${job.store.slug}.hypnate.in` : null,
      customDomain: job.store?.customDomain || null,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      buildLog: job.buildLog || [],
    });
  } catch (err) {
    next(err);
  }
};

/* ─────────────────────────────────────────────
   GET /api/hypnate-x/store
   Get the logged-in seller's store info
───────────────────────────────────────────── */
export const getMyStore = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = req.user?.sellerId;
    if (!sellerId) {
      return res.status(400).json({ message: "Seller account required" });
    }

    const store = await (prisma as any).store.findFirst({
      where: { sellerId },
      include: {
        theme: true,
        buildJobs: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            id: true,
            status: true,
            currentStep: true,
            deployedUrl: true,
            completedAt: true,
          },
        },
      },
    });

    if (!store) {
      return res.status(404).json({ message: "No store found. Start a build first." });
    }

    return res.json({
      ...store,
      storeUrl: `https://${store.slug}.hypnate.in`,
      customDomainUrl: store.customDomain ? `https://${store.customDomain}` : null,
      latestJob: store.buildJobs[0] || null,
    });
  } catch (err) {
    next(err);
  }
};

/* ─────────────────────────────────────────────
   PUT /api/hypnate-x/store
   Update store settings (name, custom domain)
───────────────────────────────────────────── */
export const updateStore = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = req.user?.sellerId;
    if (!sellerId) {
      return res.status(400).json({ message: "Seller account required" });
    }

    const { storeName, customDomain, logoUrl } = req.body;

    const store = await (prisma as any).store.findFirst({ where: { sellerId } });
    if (!store) {
      return res.status(404).json({ message: "No store found" });
    }

    const data: any = {};
    if (storeName) data.storeName = storeName.trim();
    if (logoUrl) data.logoUrl = logoUrl;
    if (customDomain !== undefined) {
      // Basic domain validation
      const domainRegex = /^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z]{2,}$/;
      if (customDomain && !domainRegex.test(customDomain)) {
        return res.status(400).json({ message: "Invalid domain format" });
      }
      data.customDomain = customDomain || null;
    }

    const updated = await (prisma as any).store.update({
      where: { id: store.id },
      data,
    });

    return res.json(updated);
  } catch (err) {
    next(err);
  }
};

/* ─────────────────────────────────────────────
   POST /api/hypnate-x/admin/seed-themes
   Seeds the 12 default themes into DB
   Run once after migration
───────────────────────────────────────────── */
export const seedThemes = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    // Basic admin guard
    if (req.user?.role !== "ADMIN") {
      return res.status(403).json({ message: "Admin only" });
    }

    const themes = [
      { id: "aurora",   name: "Aurora",   category: "fashion",     previewBg: "#0f0f1a", accentColor: "#a78bfa", layout: "editorial", tags: ["dark","luxury","fashion"] },
      { id: "saffron",  name: "Saffron",  category: "food",        previewBg: "#fff7ed", accentColor: "#f97316", layout: "bold",      tags: ["warm","food","vibrant"] },
      { id: "slate",    name: "Slate",    category: "electronics", previewBg: "#0f172a", accentColor: "#38bdf8", layout: "grid",      tags: ["dark","tech","minimal"] },
      { id: "blossom",  name: "Blossom",  category: "beauty",      previewBg: "#fff1f2", accentColor: "#fb7185", layout: "luxury",    tags: ["soft","beauty","pastel"] },
      { id: "verdant",  name: "Verdant",  category: "general",     previewBg: "#f0fdf4", accentColor: "#22c55e", layout: "minimal",   tags: ["clean","green","fresh"] },
      { id: "obsidian", name: "Obsidian", category: "furniture",   previewBg: "#1c1917", accentColor: "#d4a867", layout: "editorial", tags: ["dark","premium","warm"] },
      { id: "ivory",    name: "Ivory",    category: "fashion",     previewBg: "#fafaf9", accentColor: "#292524", layout: "luxury",    tags: ["minimal","editorial","clean"] },
      { id: "citrus",   name: "Citrus",   category: "food",        previewBg: "#fefce8", accentColor: "#eab308", layout: "bold",      tags: ["bright","food","playful"] },
      { id: "midnight", name: "Midnight", category: "electronics", previewBg: "#020617", accentColor: "#6366f1", layout: "grid",      tags: ["dark","futuristic","tech"] },
      { id: "coral",    name: "Coral",    category: "beauty",      previewBg: "#fff8f1", accentColor: "#ea580c", layout: "minimal",   tags: ["warm","beauty","modern"] },
      { id: "forest",   name: "Forest",   category: "general",     previewBg: "#14532d", accentColor: "#bbf7d0", layout: "editorial", tags: ["dark","nature","bold"] },
      { id: "birch",    name: "Birch",    category: "furniture",   previewBg: "#fdf8f0", accentColor: "#92400e", layout: "luxury",    tags: ["natural","warm","premium"] },
    ];

    let created = 0;
    for (const theme of themes) {
      await (prisma as any).theme.upsert({
        where: { id: theme.id },
        create: theme,
        update: theme,
      });
      created++;
    }

    return res.json({ message: `${created} themes seeded successfully` });
  } catch (err) {
    next(err);
  }
};

/* ─────────────────────────────────────────────
   INTERNAL — trigger Python worker via HTTP
───────────────────────────────────────────── */
const triggerPythonWorker = async (jobId: number, payload: object) => {
  const url = `${PYTHON_WORKER_URL}/build`;
  await axios.post(url, payload, {
    timeout: 10000, // 10s to accept the job (worker processes async)
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": process.env.INTERNAL_SECRET as string,
    },
  });
  console.log(`[HypnateX] Job ${jobId} dispatched to Python worker`);
};