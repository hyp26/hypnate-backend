import { Router } from "express";
import { createProduct, getAllProducts,getProductById, updateProduct, deleteProduct, updateStock, getLowStockProducts } from "../controllers/product.controller";
import { verifyToken } from "../middleware/authMiddleware";

const router = Router();
router.use(verifyToken);

router.get("/low-stock", getLowStockProducts);
router.post("/", createProduct);
router.get("/", getAllProducts);
router.get("/:id", getProductById);
router.put("/:id", updateProduct);
router.patch("/:id/stock", updateStock);
router.delete("/:id", deleteProduct);

export default router;
