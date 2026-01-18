import { Router, RequestHandler } from "express";
import { getCategories, createCategory } from "../controllers/category.controller";
import { verifyToken } from "../middleware/authMiddleware";

const router = Router();

router.get("/", getCategories);

/**
 * 🔑 Cast controller to RequestHandler
 * This is REQUIRED when controller uses AuthRequest
 */
router.post(
  "/",
  verifyToken as RequestHandler,
  createCategory as RequestHandler
);

export default router;
