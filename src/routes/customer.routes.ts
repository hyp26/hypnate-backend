import { Router } from "express";
import {
  getCustomers,
  getCustomerStats,
  getCustomerById,
  updateCustomer,
  deleteCustomer,
} from "../controllers/customer.controller";
import { verifyToken } from "../middleware/authMiddleware";
import { requirePlanFeature } from "../middleware/plan.middleware";

const router = Router();

router.use(verifyToken, requirePlanFeature("commerceWorkspace"));

/**
 * /api/customers
 */
router.get("/", verifyToken, requirePlanFeature("commerceWorkspace"), getCustomers);

// ⚠️ /stats MUST come before /:id
// Otherwise Express matches "stats" as the :id param
router.get("/stats", verifyToken, getCustomerStats);

router.get("/:id", verifyToken, getCustomerById);
router.put("/:id", verifyToken, updateCustomer);
router.delete("/:id", verifyToken, deleteCustomer);

export default router;