import { Router } from "express";
import {
  createProduct,
  getAllProducts,
  getProductById,
  updateProduct,
  deleteProduct,
  updateStock,
  getLowStockProducts
} from "../controllers/product.controller";
import { verifyToken } from "../middleware/authMiddleware";
import { getMulterForMode } from "../middleware/upload.middleware";

const router = Router();
router.use(verifyToken);

// detect mode: cloud OR local
const uploadMode = (process.env.UPLOAD_MODE as string) === "cloud" ? "cloud" : "local";
const upload = getMulterForMode(uploadMode);

router.get("/low-stock", getLowStockProducts);

// IMPORTANT → enable file upload for creation
router.post("/", upload.single("image"), createProduct);

router.get("/", getAllProducts);
router.get("/:id", getProductById);

// IMPORTANT → enable file upload for updating products
router.put("/:id", upload.single("image"), updateProduct);

router.patch("/:id/stock", updateStock);
router.delete("/:id", deleteProduct);

export default router;
