import { Router } from "express";

const router = Router();

// Deliberately does no DB/auth work — this exists purely so an external
// pinger (cron-job.org, UptimeRobot, etc.) can keep the Render instance
// from spinning down, as cheaply and fast as possible.
router.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime() });
});

export default router;