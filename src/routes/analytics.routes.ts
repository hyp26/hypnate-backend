import { Router } from "express";
import { getOverviewAnalytics } from "../controllers/analytics.controller";
import { verifyToken } from "../middleware/authMiddleware";

const router = Router();
router.use(verifyToken);

router.get("/overview", getOverviewAnalytics);

export default router;
