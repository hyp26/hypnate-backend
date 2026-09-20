import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import { verifyToken } from "../middleware/authMiddleware";
import { requirePlanFeature } from "../middleware/plan.middleware";
import { cloudUpload } from "../middleware/upload.middleware";
import { uploadBufferToCloudinary } from "../utils/cloudinary";
import {
  hasValidImageExtension,
  hasValidImageSignature,
} from "../utils/file-signature";

const router = Router();

router.use(verifyToken, requirePlanFeature("commerceWorkspace"));

router.post(
  "/",
  cloudUpload.single("file"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          message: "No file uploaded",
        });
      }

      const validExtension = hasValidImageExtension(
        req.file.originalname,
        req.file.mimetype
      );

      if (!validExtension) {
        return res.status(400).json({
          message: "File extension does not match the file type",
        });
      }

      const validSignature = hasValidImageSignature(
        req.file.buffer,
        req.file.mimetype
      );

      if (!validSignature) {
        return res.status(400).json({
          message: "Invalid or corrupted image file",
        });
      }

      const result = await uploadBufferToCloudinary(
        req.file.buffer,
        "products"
      );

      return res.status(200).json({
        url: result.secure_url,
      });
    } catch (error) {
      next(error);
    }
  }
);

/*
 * Multer errors must be handled after the upload middleware.
 *
 * This converts:
 * - oversized files -> 413
 * - rejected file types -> 400
 * - other multipart errors -> 400
 */
router.use(
  (
    error: unknown,
    _req: Request,
    res: Response,
    next: NextFunction
  ) => {
    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
          message: "File is too large",
        });
      }

      if (error.code === "LIMIT_FILE_COUNT") {
        return res.status(400).json({
          message: "Only one file can be uploaded at a time",
        });
      }

      return res.status(400).json({
        message: "Invalid file upload",
      });
    }

    if (error instanceof Error) {
      if (
        error.message.includes("Only JPEG") ||
        error.message.includes("Unsupported file type")
      ) {
        return res.status(400).json({
          message: error.message,
        });
      }
    }

    return next(error);
  }
);

export default router;