import { Router } from "express";
import { verifyToken } from "../middleware/authMiddleware";
import { getBillingStatus, createBillingSubscription, verifyBillingPayment, razorpayWebhook } from "../controllers/billing.controller";
const router = Router();
router.get("/status", verifyToken, getBillingStatus);
router.post("/subscription", verifyToken, createBillingSubscription);
router.post("/subscription/verify", verifyToken, verifyBillingPayment);
router.post("/webhook", razorpayWebhook);
export default router;
