import { Router } from "express";
import {
  createOrder,
  getOrders,
  getOrderById,
  updateOrderStatus,
  getOrderStatus,
  updatePaymentStatus,
  addTracking,
} from "../controllers/order.controller";
import { generateInvoice } from "../controllers/invoice.controller";
import { verifyToken } from "../middleware/authMiddleware";

const router = Router();

// -------------------------INVOICE ROUTE (NO verifyToken) – token comes via query param-----------------------------------
router.get("/:id/invoice", generateInvoice);


// -----------------------------ALL OTHER ROUTES REQUIRE AUTH-------------------------------
router.use(verifyToken);

router.get("/", getOrders);
router.post("/", createOrder);
router.get("/:id", getOrderById);
router.patch("/:id/status", updateOrderStatus);
router.patch("/:id/payment", updatePaymentStatus);
router.post("/:id/track", addTracking);
router.get("/:id/status", getOrderStatus);

export default router;
