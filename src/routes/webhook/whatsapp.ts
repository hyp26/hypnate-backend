import { Router } from "express";
import { verifyWebhook } from "../../controllers/webhook/whatsapp/verify.controller";
import { receiveMessage } from "../../controllers/webhook/whatsapp/incoming.controller";

const router = Router();

router.get("/", verifyWebhook);
router.post("/", receiveMessage);

export default router;