import { Router } from "express";
import {
  getNotifications,
  markOneRead,
  markAllRead,
  deleteNotification,
} from "../controllers/notification.controller";
import { verifyToken } from "../middleware/authMiddleware";

const router = Router();

// ── Notifications ──
router.get("/", verifyToken, getNotifications);
router.patch("/read-all", verifyToken, markAllRead);       // must be before /:id
router.patch("/:id/read", verifyToken, markOneRead);
router.delete("/:id", verifyToken, deleteNotification);

export default router;