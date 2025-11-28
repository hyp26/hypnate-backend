import { Router, Request, Response, NextFunction } from "express";
import { getMulterForMode } from "../middleware/upload.middleware";
import { uploadBufferToCloudinary } from "../utils/cloudinary";
import prisma from "../prisma/client";

const router = Router();

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const mode = (req.query.mode as string) === "cloud" ? "cloud" : "local";
    const upload = getMulterForMode(mode).single("file");

    upload(req, res, async (err: any) => {
      if (err) return next(err);
      if (!req.file) return res.status(400).json({ message: "No file provided" });

      if (mode === "local") {
        // req.file.path exists
        const url = `${req.protocol}://${req.get("host")}/${(req.file as any).path.replace(/^\.\//, "")}`;
        return res.json({ url, storage: "local", filename: (req.file as any).filename });
      }

      // cloud mode -> req.file.buffer
      const fileBuffer = (req.file as any).buffer as Buffer;
      try {
        const { secure_url, public_id } = await uploadBufferToCloudinary(fileBuffer, "hypnate");
        return res.json({ url: secure_url, storage: "cloud", public_id });
      } catch (uploadErr) {
        return next(uploadErr);
      }
    });
  } catch (err) {
    next(err);
  }
});

export default router;
