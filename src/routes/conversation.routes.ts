import { Router } from "express";
import {
  getConversations,
  getConversationById,
  getConversationStats,
  getMessages,
  sendMessage,
  updateConversationStatus,
} from "../controllers/conversation.controller";
import { verifyToken } from "../middleware/authMiddleware";
import { assignConversation } from "../controllers/assign.controller";

const router = Router();

// ── Stats — must be before /:id to avoid param collision ──
router.get("/stats", verifyToken, getConversationStats);

// ── Webhook routes — no auth (verified by platform token) ─

// ── Authenticated seller routes ──
router.get("/", verifyToken, getConversations);
router.get("/:id", verifyToken, getConversationById);
router.get("/:id/messages", verifyToken, getMessages);
router.post("/:id/messages", verifyToken, sendMessage);
router.patch("/:id/status", verifyToken, updateConversationStatus);

// ── Assign conversation route ──
router.patch(
  "/conversations/:id/assign",
  assignConversation
);

export default router;