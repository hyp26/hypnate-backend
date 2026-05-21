import { Router } from "express";
import { telegramWebhook } from "../../controllers/webhook/telegram/telegram.controller";

const router = Router();

router.post("/telegram/:sellerId", telegramWebhook);

export default router;