import { Router } from "express";
import { telegramWebhook } from "../../controllers/webhook/telegram/incoming.controller";
import { verifyTelegramWebhookSecret } from "../../middleware/telegram-webhook.middleware";

const router = Router();

router.post(
  "/telegram/:sellerId",
  verifyTelegramWebhookSecret,
  telegramWebhook
);

export default router;