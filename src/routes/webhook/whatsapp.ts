import { Router } from "express";

import { verifyWebhook } from "../../controllers/webhook/whatsapp/verify.controller";
import { receiveMessage } from "../../controllers/webhook/whatsapp/incoming.controller";
import { verifyWhatsAppSignature } from "../../middleware/whatsapp-signature.middleware";

const router = Router();

/*
 * Meta webhook verification handshake.
 *
 * This is a GET request and does not use X-Hub-Signature-256.
 */
router.get("/", verifyWebhook);

/*
 * All incoming WhatsApp webhook events must pass
 * Meta signature verification before processing.
 */
router.post(
  "/",
  verifyWhatsAppSignature,
  receiveMessage
);

export default router;