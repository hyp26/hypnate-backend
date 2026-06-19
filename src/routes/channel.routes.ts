import { Router } from "express";
import { connectTelegram } from "../controllers/channel.controller";
import { verifyToken } from "../middleware/authMiddleware";


const router = Router();

router.post(
  "/telegram",
  verifyToken,
  connectTelegram
);

export default router;