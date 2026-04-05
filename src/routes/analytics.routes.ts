import { Router } from "express";
import { verifyToken } from "../middleware/authMiddleware";
import { getOverviewAnalytics, exportAnalytics } from "../controllers/analytics.controller";

const router = Router();

router.get("/overview", verifyToken, getOverviewAnalytics);
router.get("/export", verifyToken, exportAnalytics);

export default router;