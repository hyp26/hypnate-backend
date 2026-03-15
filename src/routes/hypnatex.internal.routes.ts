import { Router, Request, Response, NextFunction } from "express";
import prisma from "../prisma/client";

const router = Router();
const INTERNAL_KEY = process.env.INTERNAL_API_KEY;

/* --------------------------------------------------
   Guard — only Python worker can call these routes
-------------------------------------------------- */
const internalOnly = (req: Request, res: Response, next: NextFunction) => {
  const key = req.headers["x-internal-key"];
  if (!INTERNAL_KEY || key !== INTERNAL_KEY) {
    return res.status(403).json({ message: "Forbidden" });
  }
  return next();
};

const VALID_STATUSES = [
  "QUEUED", "GENERATING_PAGES", "UPLOADING_PRODUCTS",
  "APPLYING_THEME", "DEPLOYING", "DONE", "FAILED",
];

/* --------------------------------------------------
   PATCH /api/hypnate-x/internal/job/:jobId
   Python worker pushes status updates here
-------------------------------------------------- */
router.patch(
  "/job/:jobId",
  internalOnly,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const jobId = parseInt(req.params.jobId); // ✅ Int id in schema
      if (isNaN(jobId)) return res.status(400).json({ message: "Invalid jobId" });

      const { status, log, error, siteUrl } = req.body;

      if (!VALID_STATUSES.includes(status)) {
        return res.status(400).json({ message: "Invalid status" });
      }

      const job = await prisma.buildJob.findUnique({ where: { id: jobId } });
      if (!job) return res.status(404).json({ message: "Job not found" });

      // ✅ buildLog is Json? — store as array of {time, message} objects
      const existingLog = Array.isArray(job.buildLog) ? job.buildLog as any[] : [];
      const updatedLog = log
        ? [...existingLog, { time: new Date().toISOString(), message: log }]
        : existingLog;

      await prisma.buildJob.update({
        where: { id: jobId },
        data: {
          status,
          currentStep: log ?? job.currentStep,  // ✅ String? in schema
          buildLog: updatedLog,                  // ✅ Json? in schema
          ...(error   && { errorMsg: error }),   // ✅ errorMsg not error
          ...(siteUrl && { deployedUrl: siteUrl }), // ✅ deployedUrl not siteUrl
          ...(["DONE", "FAILED"].includes(status) && { completedAt: new Date() }),
        },
      });

      // ✅ StoreStatus enum — no isLive boolean in schema
      if (status === "DONE") {
        await prisma.store.update({
          where: { id: job.storeId },
          data: { status: "LIVE", publishedAt: new Date() },
        });
      }

      if (status === "FAILED") {
        await prisma.store.update({
          where: { id: job.storeId },
          data: { status: "BUILDING" }, // stays BUILDING so seller can retry
        });
      }

      return res.json({ ok: true, jobId, status });
    } catch (err) {
      next(err);
    }
  }
);

/* --------------------------------------------------
   POST /api/hypnate-x/internal/pages/:storeId
   Python worker saves AI-generated content to Store
-------------------------------------------------- */
router.post(
  "/pages/:storeId",
  internalOnly,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = parseInt(req.params.storeId); // ✅ Int id in schema
      if (isNaN(storeId)) return res.status(400).json({ message: "Invalid storeId" });

      const { homepageHtml, aboutHtml, metaTitle, metaDesc, deployedUrl } = req.body;

      // ✅ Schema stores HTML directly on Store — no separate StorePage model
      await prisma.store.update({
        where: { id: storeId },
        data: {
          ...(homepageHtml && { homepageHtml }),
          ...(aboutHtml   && { aboutHtml }),
          ...(metaTitle   && { metaTitle }),
          ...(metaDesc    && { metaDesc }),
          ...(deployedUrl && { status: "LIVE", publishedAt: new Date() }),
        },
      });

      return res.json({ ok: true, storeId });
    } catch (err) {
      next(err);
    }
  }
);

export default router;