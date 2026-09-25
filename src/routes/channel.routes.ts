import { Router } from "express";
import {
  connectTelegram,
  connectWhatsApp,
  whatsappCallback,
  getWhatsAppStatus,
  validateWhatsAppConnection,
  disconnectWhatsApp,
} from "../controllers/channel.controller";
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

// WhatsApp connection lifecycle
router.get(
  "/whatsapp/status",
  verifyToken,
  requirePlanFeature("commerceWorkspace"),
  getWhatsAppStatus
);

router.post(
  "/whatsapp/validate",
  verifyToken,
  requirePlanFeature("commerceWorkspace"),
  validateWhatsAppConnection
);

router.post(
  "/whatsapp/disconnect",
  verifyToken,
  requirePlanFeature("commerceWorkspace"),
  disconnectWhatsApp
);

// Meta callback
router.get(
  "/whatsapp/callback",
  whatsappCallback
);

export default router;
