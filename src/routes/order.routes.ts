// src/routes/order.route.ts
import { Router } from "express";
import {
  createOrder,
  getOrders,
  getOrderById,
  updateOrderStatus,
  getOrderStatus,
  updatePaymentStatus,
  addTracking
} from "../controllers/order.controller";
import { verifyToken } from "../middleware/authMiddleware";

const router = Router();
router.use(verifyToken);

// list & create
router.get("/", getOrders);
router.post("/", createOrder);

// order detail
router.get("/:id", getOrderById);

// status update (PATCH)
router.patch("/:id/status", updateOrderStatus);

// payment update
router.patch("/:id/payment", updatePaymentStatus);

// add tracking
router.post("/:id/track", addTracking);

// get raw status (compat)
router.get("/:id/status", getOrderStatus);

export default router;
