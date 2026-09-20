import { Router } from "express";
import { globalSearch } from "../controllers/search.controller";
import { verifyToken } from "../middleware/authMiddleware";
import { requirePlanFeature } from "../middleware/plan.middleware";

export const searchRouter = Router();

searchRouter.get("/", verifyToken, requirePlanFeature("commerceWorkspace"), globalSearch);