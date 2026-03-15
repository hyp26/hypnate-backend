import { Router, RequestHandler } from "express";
import { verifyToken } from "../middleware/authMiddleware";
import {
  startBuild,
  getBuildStatus,
  getMyStore,
  listThemes,
  updateStore,
  seedThemes,
} from "../controllers/hypnatex.controller";

const router = Router();

/* ---------------------------
   PUBLIC
---------------------------- */
// List all available themes (no auth needed for theme picker preview)
router.get("/themes", listThemes as RequestHandler);

/* ---------------------------
   PROTECTED
---------------------------- */
router.use(verifyToken as RequestHandler);

// Start a new AI website build
router.post("/build", startBuild as RequestHandler);

// Poll build job status (frontend polls this every 3s)
router.get("/status/:jobId", getBuildStatus as RequestHandler);

// Get merchant's current store
router.get("/store", getMyStore as RequestHandler);

// Update store settings (name, custom domain, etc.)
router.put("/store", updateStore as RequestHandler);

/* ---------------------------
   ADMIN ONLY
---------------------------- */
// Seed default themes into DB (run once)
router.post("/admin/seed-themes", seedThemes as RequestHandler);

export default router;