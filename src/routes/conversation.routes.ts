import { Router } from "express";
import {
  getConversations,
  getConversationById,
  getConversationStats,
  getMessages,
  sendMessage,
  receiveWebhook,
  verifyWebhook,
  updateConversationStatus,
} from "../controllers/conversation.controller";
import { verifyToken } from "../middleware/authMiddleware";

const router = Router();

// ── Stats — must be before /:id to avoid param collision ──
router.get("/stats", verifyToken, getConversationStats);

// ── Webhook routes — no auth (verified by platform token) ──
// GET is for WhatsApp/Facebook verification handshake
// POST receives actual incoming messages
router.get("/webhook/:platform", verifyWebhook);
router.post("/webhook/:platform", receiveWebhook);

// ── Authenticated seller routes ──
router.get("/", verifyToken, getConversations);
router.get("/:id", verifyToken, getConversationById);
router.get("/:id/messages", verifyToken, getMessages);
router.post("/:id/messages", verifyToken, sendMessage);
router.patch("/:id/status", verifyToken, updateConversationStatus);

export default router;