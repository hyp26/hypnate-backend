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
import { generateInvoice } from "../controllers/invoice.controller";
import { verifyToken } from "../middleware/authMiddleware";

const router = Router();
router.use(verifyToken);

// Order routes
router.get("/", getOrders);
router.post("/", createOrder);
router.get("/:id", getOrderById);
router.patch("/:id/status", updateOrderStatus);
router.patch("/:id/payment", updatePaymentStatus);
router.post("/:id/track", addTracking);
router.get("/:id/status", getOrderStatus);

// generate invoice
router.get("/:id/invoice", generateInvoice);

export default router;
