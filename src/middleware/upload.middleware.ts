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

/* ---------------- FILE FILTERS ---------------- */

const IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];

// CHANGED: this used to be a single hardcoded imageFileFilter. It's now a
// factory so different upload types (images vs. catalog documents) can each
// bring their own allowed list instead of sharing one.
function makeFileFilter(allowedMimeTypes: string[], rejectionMessage: string) {
  return function fileFilter(
    _req: Request,
    file: Express.Multer.File,
    cb: FileFilterCallback
  ): void {
    if (!allowedMimeTypes.includes(file.mimetype)) {
      return cb(new Error(rejectionMessage));
    }
    cb(null, true);
  };
}

const imageFileFilter = makeFileFilter(
  IMAGE_MIME_TYPES,
  "Only image files (jpeg, png, webp, gif) are allowed"
);

const CATALOG_MIME_TYPES = [
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/pdf",
  "application/msword", // .doc
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "text/plain",
];

const catalogFileFilter = makeFileFilter(
  CATALOG_MIME_TYPES,
  "Unsupported file type. Upload a CSV, Excel, PDF, Word, or text file."
);

/* ---------------- FACTORY ---------------- */

// CHANGED: now takes storage/filter/size as options instead of assuming
// images every time. Defaults match the original behavior exactly, so
// existing calls with no options still produce the same image-only,
// 5MB-limited uploader as before.
export function getMulterForMode(
  mode: "local" | "cloud",
  options?: {
    fileFilter?: ReturnType<typeof makeFileFilter>;
    maxFileSize?: number;
  }
) {
  return multer({
    storage: mode === "local" ? diskStorage : memoryStorage,
    limits: {
      fileSize: options?.maxFileSize ?? MAX_FILE_SIZE,
    },
    fileFilter: options?.fileFilter ?? imageFileFilter,
  });
}

/* ---------------- READY-TO-USE EXPORTS ---------------- */

// Unchanged — same image-only uploaders as before.
export const localUpload = getMulterForMode("local");
export const cloudUpload = getMulterForMode("cloud");

// NEW: for the catalog import step. Memory storage (the file's parsed
// in-request and never needs to touch disk) and a larger size cap, since a
// PDF/DOCX catalog is typically bigger than a product photo.
export const catalogUpload = getMulterForMode("cloud", {
  fileFilter: catalogFileFilter,
  maxFileSize: Number(process.env.MAX_CATALOG_FILE_SIZE) || 15 * 1024 * 1024,
});