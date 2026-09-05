import { Router, RequestHandler } from "express";
import { sendMessage } from "../../controllers/webhook/telegram/outgoing.controller";
import { verifyToken } from "../../middleware/authMiddleware";

const router = Router();

/**
 * Legacy Telegram send endpoint.
 *
 * It remains temporarily for compatibility with older clients,
 * but it is fully authenticated and tenant-scoped.
 */
router.post(
  "/send",
  verifyToken as RequestHandler,
  sendMessage
);

export default router;