import { Router } from "express";
import { joinWaitlist } from "../controllers/waitlist.controller";

const router = Router();

router.post("/", joinWaitlist);

export default router;
