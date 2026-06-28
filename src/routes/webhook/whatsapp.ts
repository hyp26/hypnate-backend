import { Router } from "express";
import {
  connectWhatsApp,
} from "../../controllers/channels/whatsapp/connect.controller";
import {
  whatsappCallback,
} from "../../controllers/channels/whatsapp/callback.controller";

const router = Router();

router.get("/connect", connectWhatsApp);
router.get("/callback", whatsappCallback);

export default router;