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
import { exportOrders } from "../controllers/orderExport.controller";
import { verifyToken } from "../middleware/authMiddleware";

const router = Router();

/* -----------------------------------------------------------------------
   PUBLIC ROUTES (NO verifyToken)
   These accept ?token=... via query param because window.open cannot send headers
------------------------------------------------------------------------ */

router.get("/export/all", exportOrders);   
router.get("/:id/invoice", generateInvoice);


/* -----------------------------------------------------------------------
   PROTECTED ROUTES (REQUIRE AUTH HEADER TOKEN)
------------------------------------------------------------------------ */

router.use(verifyToken);

router.get("/", getOrders);
router.post("/", createOrder);
router.get("/:id", getOrderById);
router.patch("/:id/status", updateOrderStatus);
router.patch("/:id/payment", updatePaymentStatus);
router.post("/:id/track", addTracking);
router.get("/:id/status", getOrderStatus);

export default router;
