import { Router } from "express";
import {
  createProduct,
  getAllProducts,
  getProductById,
  updateProduct,
  deleteProduct,
  updateStock,
  getLowStockProducts,
} from "../controllers/product.controller";
import { verifyToken } from "../middleware/authMiddleware";

const router = Router();

// protect all product routes
router.use(verifyToken);

router.get("/low-stock", getLowStockProducts);

// Product creation is JSON-only (image already uploaded separately)
router.post("/", createProduct);

router.get("/", getAllProducts);
router.get("/:id", getProductById);

// Update product via JSON patch (imageUrl optional)
router.put("/:id", updateProduct);

router.patch("/:id/stock", updateStock);
router.delete("/:id", deleteProduct);

export default router;
