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
   HELPER — check if error is Prisma unique constraint violation
───────────────────────────────────────────── */

const isPrismaUniqueConflict = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: string }).code === "P2002";

const getSlugCandidate = (base: string, sellerId: number, attempt: number) => {
  if (attempt === 0) return base;
  if (attempt === 1) return `${base}-${sellerId}`;
  return `${base}-${sellerId}-${attempt - 1}`;
};



type StartBuildResult =
  | {
      kind: "active";
      activeJob: { id: number };
    }
  | {
      kind: "created";
      store: any;
      buildJob: { id: number };
      slug: string;
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
      return res.status(400).json({
        message: "Seller account required to build a store",
      });
    }

    if (!themeId || typeof storeName !== "string") {
      return res.status(400).json({
        message: "themeId and storeName are required",
      });
    }

    const normalizedName = storeName.trim();

    if (normalizedName.length < 2 || normalizedName.length > 60) {
      return res.status(400).json({
        message: "Store name must be between 2 and 60 characters",
      });
    }

    const theme = await (prisma as any).theme.findUnique({
      where: { id: themeId },
    });

    if (!theme) {
      return res.status(404).json({ message: "Theme not found" });
    }

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
      take: 100,
    });

    const seller = await prisma.seller.findUnique({
      where: { id: sellerId },
      select: { businessName: true, phone: true },
    });

    const baseSlug = makeSlug(normalizedName) || `store-${sellerId}`;

    let result: StartBuildResult | null = null;

    // Retry unique conflicts caused by concurrent slug allocation.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        result = await (prisma as any).$transaction(
          async (tx: any): Promise<StartBuildResult> => {
            // Serialize build creation for the same seller.
            await tx.$executeRaw`
              SELECT pg_advisory_xact_lock(
                1279872594::integer,
                ${sellerId}::integer
              )
            `;
            const activeJob = await tx.buildJob.findFirst({
              where: {
                sellerId,
                status: { notIn: ["DONE", "FAILED"] },
              },
            });

            if (activeJob) {
              return {
                kind: "active",
                activeJob,
              };
            }

            let store: any = null;
            let selectedSlug = "";

            for (let slugAttempt = 0; slugAttempt < 100; slugAttempt++) {
              const candidate = getSlugCandidate(
                baseSlug,
                sellerId,
                slugAttempt
              );

              const existing = await tx.store.findUnique({
                where: { slug: candidate },
              });

              if (!existing) {
                store = await tx.store.create({
                  data: {
                    sellerId,
                    themeId,
                    storeName: normalizedName,
                    slug: candidate,
                    logoUrl: logoUrl || null,
                    status: "BUILDING",
                  },
                });

                selectedSlug = candidate;
                break;
              }

              // Never update a store owned by another seller.
              if (existing.sellerId !== sellerId) {
                continue;
              }

              const updateResult = await tx.store.updateMany({
                where: {
                  id: existing.id,
                  sellerId,
                },
                data: {
                  themeId,
                  storeName: normalizedName,
                  logoUrl: logoUrl || null,
                  status: "BUILDING",
                  publishedAt: null,
                },
              });

              if (updateResult.count !== 1) {
                throw new Error(
                  "Store ownership changed during build creation"
                );
              }

              store = await tx.store.findFirst({
                where: {
                  id: existing.id,
                  sellerId,
                },
              });

              if (!store) {
                throw new Error(
                  "Seller-owned store could not be reloaded"
                );
              }

              selectedSlug = candidate;
              break;
            }

            if (!store) {
              throw new Error("Unable to allocate a unique store slug");
            }

            const buildJob = await tx.buildJob.create({
              data: {
                storeId: store.id,
                sellerId,
                themeId,
                storeName: normalizedName,
                logoUrl: logoUrl || null,
                status: "QUEUED",
                currentStep: "Queued — waiting for worker",
                catalogJson: products,
                startedAt: new Date(),
              },
            });

            return {
              kind: "created",
              store,
              buildJob,
              slug: selectedSlug,
            };
          }
        );

        // Ensure the transaction returned a result.
        if (!result) {
          throw new Error("HypnateX build transaction returned no result");
        }

        // An active build already exists for this seller.
        if (result.kind === "active") {
          return res.status(409).json({
            message: "A build is already in progress",
            jobId: result.activeJob.id,
          });
        }

        break;
      } catch (error) {
        if (isPrismaUniqueConflict(error) && attempt < 4) {
          continue;
        }

        throw error;
      }
    }

    if (!result || result.kind !== "created") {
      throw new Error("Unable to create HypnateX build");
    }

    const { store, buildJob, slug } = result;

    // Dispatch only after the transaction has committed.
    // Database-backed tests must not trigger the external Python worker.
    if (process.env.NODE_ENV !== "test") {
      triggerPythonWorker(buildJob.id, {
        jobId: buildJob.id,
        storeId: store.id,
        sellerId,
        themeId,
        themeName: theme.name,
        themeCategory: theme.category,
        storeName: normalizedName,
        logoUrl: logoUrl || null,
        slug,
        products,
        seller,
      }).catch((err) => {
        logger.error(
          `[HypnateX] Worker trigger failed for job ${buildJob.id}:`,
          err.message
        );

        (prisma as any).buildJob
          .updateMany({
            where: {
              id: buildJob.id,
              sellerId,
            },
            data: {
              status: "FAILED",
              errorMessage: "Failed to trigger build worker",
            },
          })
          .catch((updateErr: unknown) => {
            logger.error(
              `[HypnateX] Failed to mark job ${buildJob.id} as FAILED:`,
              updateErr
            );
          });
      });
    }

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
    if (!sellerId) {
      return res.status(400).json({ message: "Seller account required" });
    }

    const { storeName, customDomain, logoUrl } = req.body;

    const store = await (prisma as any).store.findFirst({
      where: { sellerId },
      select: { id: true },
    });

    if (!store) {
      return res.status(404).json({ message: "No store found" });
    }

    const data: any = {};

    if (storeName) data.storeName = storeName.trim();
    if (logoUrl) data.logoUrl = logoUrl;

    if (customDomain !== undefined) {
      const domainRegex = /^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z]{2,}$/;

      if (customDomain && !domainRegex.test(customDomain)) {
        return res.status(400).json({ message: "Invalid domain format" });
      }

      data.customDomain = customDomain || null;
    }

    const updated = await (prisma as any).store.updateMany({
      where: {
        id: store.id,
        sellerId,
      },
      data,
    });

    if (updated.count !== 1) {
      return res.status(404).json({ message: "Store not found or ownership changed" });
    }

    const updatedStore = await (prisma as any).store.findFirst({
      where: {
        id: store.id,
        sellerId,
      },
    });

    if (!updatedStore) {
      return res.status(404).json({ message: "Store not found" });
    }

    return res.json(updatedStore);
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