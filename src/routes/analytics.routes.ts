import { Router } from "express";
import { verifyToken } from "../middleware/authMiddleware";
import { requirePlanFeature } from "../middleware/plan.middleware";
import { getOverviewAnalytics, exportAnalytics } from "../controllers/analytics.controller";

const router = Router();

router.get("/overview", verifyToken, requirePlanFeature("advancedAnalytics"), getOverviewAnalytics);
router.get("/export", verifyToken, requirePlanFeature("advancedAnalytics"), exportAnalytics);

export default router;