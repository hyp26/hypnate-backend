import { Router } from "express";
import { verifyToken } from "../middleware/authMiddleware";
import { getOverviewAnalytics } from "../controllers/analytics.controller";

const router = Router();

// ✅ ALWAYS pass middleware + controller
router.get("/overview", verifyToken, getOverviewAnalytics);

export default router;
