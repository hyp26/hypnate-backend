import { Router } from "express";
import { sendMessage } from "../../controllers/webhook/message.controller";

const router = Router();

router.post("/send", sendMessage);

export default router;