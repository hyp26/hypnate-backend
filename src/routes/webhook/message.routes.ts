import { Router, RequestHandler } from "express";
import { sendMessage } from "../../controllers/webhook/telegram/outgoing.controller";
import { verifyToken } from "../../middleware/authMiddleware";

const router = Router();

/**
 * Legacy Telegram send endpoint.
 *
 * Kept temporarily for compatibility with older clients.
 * Authentication and tenant isolation are enforced.
 */
router.post(
  "/send",
  verifyToken as RequestHandler,
  sendMessage
);

export default router;