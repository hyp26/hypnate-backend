import { Router, RequestHandler } from "express";
import { verifyToken } from "../middleware/authMiddleware";
import { requirePlanFeature } from "../middleware/plan.middleware";
import {
  startBuild,
  getBuildStatus,
  getMyStore,
  listThemes,
  updateStore,
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
router.post("/build", requirePlanFeature("hypnateX") as RequestHandler, startBuild as RequestHandler);

// Poll build job status (frontend polls this every 3s)
router.get("/status/:jobId", requirePlanFeature("hypnateX") as RequestHandler, getBuildStatus as RequestHandler);

// Get merchant's current store
router.get("/store", requirePlanFeature("hypnateX") as RequestHandler, getMyStore as RequestHandler);

// Update store settings (name, custom domain, etc.)
router.put("/store", requirePlanFeature("hypnateX") as RequestHandler, updateStore as RequestHandler);


export default router;