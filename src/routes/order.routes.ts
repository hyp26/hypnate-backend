import { Router, Request, Response, NextFunction } from "express";
import { verifyToken } from "../middleware/authMiddleware";
import {
  createOrder,
  getOrders,
  getOrderById,
  updateOrderStatus,
  updatePaymentStatus,
  addTracking,
} from "../controllers/order.controller";
import { exportOrders } from "../controllers/orderExport.controller";

const router = Router();

/**
 * Helper to adapt AuthRequest controllers to Express
 */
const authHandler =
  (fn: any) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

// --------------------------------------------------
// Orders
// --------------------------------------------------
router.post("/", verifyToken, authHandler(createOrder));
router.get("/", verifyToken, authHandler(getOrders));
router.get("/:id", verifyToken, authHandler(getOrderById));

// Status & payment
router.patch("/:id/status", verifyToken, authHandler(updateOrderStatus));
router.patch("/:id/payment", verifyToken, authHandler(updatePaymentStatus));
router.post("/:id/track", verifyToken, authHandler(addTracking));

// Export
router.get("/export/all", verifyToken, authHandler(exportOrders));

export default router;
