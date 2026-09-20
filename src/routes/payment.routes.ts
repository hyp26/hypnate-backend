import { Router } from "express";
import { verifyToken } from "../middleware/authMiddleware";
import { requirePlanFeature } from "../middleware/plan.middleware";
import {
  getPayments,
  getPaymentStats,
  exportPayments,
  createPaymentLink,
} from "../controllers/payment.controller";

const router = Router();

router.use(verifyToken, requirePlanFeature("commerceWorkspace"));

// ── Stats first (before /:id patterns) ──
router.get("/stats", verifyToken, getPaymentStats);
router.get("/export", verifyToken, exportPayments);

// ── List transactions ──
router.get("/", verifyToken, getPayments);

// ── Create payment link ──
router.post("/link", requirePlanFeature("paymentLinks"), createPaymentLink);

export default router;