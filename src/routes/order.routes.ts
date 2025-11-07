import { Router } from "express";
import { createOrder, getOrders, getOrderById, updateOrderStatus, getOrderStatus } from "../controllers/order.controller";
import { verifyToken } from "../middleware/authMiddleware";

const router = Router();
router.use(verifyToken);

router.get("/", getOrders);
router.post("/", createOrder);
router.get("/:id", getOrderById);
router.put("/:id/status", updateOrderStatus);
router.get("/:id/status", getOrderStatus);


export default router;
