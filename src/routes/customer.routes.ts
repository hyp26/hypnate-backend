import { Router } from "express";
import {
  getCustomers,
  getCustomerStats,
  getCustomerById,
  updateCustomer,
  deleteCustomer,
} from "../controllers/customer.controller";
import { verifyToken } from "../middleware/authMiddleware";

const router = Router();

/**
 * /api/customers
 */
router.get("/", verifyToken, getCustomers);

// ⚠️ /stats MUST come before /:id
// Otherwise Express matches "stats" as the :id param
router.get("/stats", verifyToken, getCustomerStats);

router.get("/:id", verifyToken, getCustomerById);
router.put("/:id", verifyToken, updateCustomer);
router.delete("/:id", verifyToken, deleteCustomer);

export default router;