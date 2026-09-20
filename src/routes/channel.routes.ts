import { Router } from "express";
import { connectTelegram, connectWhatsApp, whatsappCallback } from "../controllers/channel.controller";
import { verifyToken } from "../middleware/authMiddleware";
import { requirePlanFeature } from "../middleware/plan.middleware";


const router = Router();

router.post(
  "/telegram",
  verifyToken,
  requirePlanFeature("commerceWorkspace"),
  connectTelegram
);

// WhatsApp OAuth
router.get(
  "/whatsapp/connect",
  verifyToken,
  requirePlanFeature("commerceWorkspace"),
  connectWhatsApp
);

// Meta callback
router.get(
  "/whatsapp/callback",
  whatsappCallback
);

export default router;