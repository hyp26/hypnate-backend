import { Router } from "express";
import { telegramWebhook } from "../../controllers/webhook/telegram.controller";

const router = Router();

router.post("/telegram", telegramWebhook);

export default router;