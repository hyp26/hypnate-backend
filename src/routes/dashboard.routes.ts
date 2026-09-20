import { Router } from "express";
import { getDashboard } from "../controllers/dashboard.controller";
import { verifyToken } from "../middleware/authMiddleware";
import { requirePlanFeature } from "../middleware/plan.middleware";

const router = Router();

router.get("/", verifyToken, requirePlanFeature("commerceWorkspace"), getDashboard);

export default router;