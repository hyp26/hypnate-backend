import { Router } from "express";
import { getCategories, createCategory } from "../controllers/category.controller";
import { verifyToken } from "../middleware/authMiddleware";

const router = Router();

router.get("/", getCategories);

// Optional: protect createCategory if you want only admins to create categories
router.post("/", verifyToken, createCategory);

export default router;
