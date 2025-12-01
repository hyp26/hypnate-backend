import { Router } from "express";
import multer from "multer";
import { verifyToken } from "../middleware/authMiddleware";
import { uploadBufferToCloudinary } from "../utils/cloudinary";

const router = Router();
const upload = multer(); // memory storage

router.use(verifyToken);

router.post("/", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    const result = await uploadBufferToCloudinary(req.file.buffer, "products");

    res.json({ url: result.secure_url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Image upload failed" });
  }
});

export default router;
