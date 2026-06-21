import multer, { FileFilterCallback } from "multer";
import path from "path";
import fs from "fs";
import { Request } from "express";

const uploadsDir = process.env.UPLOADS_DIR || "./uploads";

// Ensure upload directory exists
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

/* ---------------- STORAGE ---------------- */

// Local disk storage
const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },

  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const filename = `${Date.now()}-${Math.round(
      Math.random() * 1_000_000_000
    )}${ext}`;

    cb(null, filename);
  },
});

// Cloud storage mode (buffer only)
const memoryStorage = multer.memoryStorage();

/* ---------------- LIMITS ---------------- */

export const MAX_FILE_SIZE =
  Number(process.env.MAX_FILE_SIZE) || 5 * 1024 * 1024;

/* ---------------- FILE FILTER ---------------- */

const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];

function imageFileFilter(
  _req: Request,
  file: Express.Multer.File,
  cb: FileFilterCallback
): void {
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    return cb(
      new Error(
        "Only image files (jpeg, png, webp, gif) are allowed"
      )
    );
  }

  cb(null, true);
}

/* ---------------- FACTORY ---------------- */

export function getMulterForMode(mode: "local" | "cloud") {
  return multer({
    storage: mode === "local" ? diskStorage : memoryStorage,
    limits: {
      fileSize: MAX_FILE_SIZE,
    },
    fileFilter: imageFileFilter,
  });
}

/* ---------------- READY-TO-USE EXPORTS ---------------- */

export const localUpload = getMulterForMode("local");
export const cloudUpload = getMulterForMode("cloud");