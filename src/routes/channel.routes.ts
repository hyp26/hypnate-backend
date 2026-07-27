import { Router } from "express";
import { connectTelegram, connectWhatsApp, whatsappCallback } from "../controllers/channel.controller";
import { verifyToken } from "../middleware/authMiddleware";


const router = Router();

router.post(
  "/telegram",
  verifyToken,
  connectTelegram
);

// WhatsApp OAuth
router.get(
  "/whatsapp/connect",
  verifyToken,
  connectWhatsApp
);

// Meta callback
router.get(
  "/whatsapp/callback",
  whatsappCallback
);

export default router;