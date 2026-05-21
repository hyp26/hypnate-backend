import { Router } from "express";
import { connectTelegram } from "../controllers/channel.controller";

const router = Router();

router.post("/telegram/:sellerId", connectTelegram);

export default router;