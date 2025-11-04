import { Router } from "express";
import { getAllOrders, createOrder } from "../controllers/order.controller";

const router = Router();

router.get("/", getAllOrders);
router.post("/", createOrder);

export default router;
