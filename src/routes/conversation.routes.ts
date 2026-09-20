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
import { requirePlanFeature } from "../middleware/plan.middleware";
import { assignConversation } from "../controllers/assign.controller";

const router = Router();

router.use(verifyToken, requirePlanFeature("commerceWorkspace"));

// ─────────────────────────────────────────────
// STATS
// Must be before /:id to avoid parameter collision.
// ─────────────────────────────────────────────
router.get(
  "/stats",
  verifyToken,
  getConversationStats
);

// ─────────────────────────────────────────────
// AUTHENTICATED SELLER ROUTES
// ─────────────────────────────────────────────
router.get(
  "/",
  verifyToken,
  requirePlanFeature("commerceWorkspace"),
  getConversations
);

router.get(
  "/:id",
  verifyToken,
  getConversationById
);

router.get(
  "/:id/messages",
  verifyToken,
  getMessages
);

router.post(
  "/:id/messages",
  verifyToken,
  sendMessage
);

router.patch(
  "/:id/status",
  verifyToken,
  updateConversationStatus
);

// ─────────────────────────────────────────────
// ASSIGN CONVERSATION
// Authentication is REQUIRED.
// Controller additionally verifies seller ownership.
// ─────────────────────────────────────────────
router.patch(
  "/:id/assign",
  verifyToken,
  assignConversation
);

export default router;