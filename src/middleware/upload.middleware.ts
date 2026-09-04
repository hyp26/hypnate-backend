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

const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },

  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();

    const filename = `${Date.now()}-${Math.round(
      Math.random() * 1_000_000_000
    )}${ext}`;

    cb(null, filename);
  },
});

const memoryStorage = multer.memoryStorage();

/* ---------------- LIMITS ---------------- */

export const MAX_FILE_SIZE =
  Number(process.env.MAX_FILE_SIZE) || 5 * 1024 * 1024;

export const MAX_CATALOG_FILE_SIZE =
  Number(process.env.MAX_CATALOG_FILE_SIZE) || 15 * 1024 * 1024;

/* ---------------- FILE TYPES ---------------- */

const IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];

const IMAGE_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
];

const CATALOG_MIME_TYPES = [
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
];

const CATALOG_EXTENSIONS = [
  ".csv",
  ".xls",
  ".xlsx",
  ".pdf",
  ".doc",
  ".docx",
  ".txt",
];

/* ---------------- HELPERS ---------------- */

function makeFileFilter(
  allowedMimeTypes: string[],
  allowedExtensions: string[],
  rejectionMessage: string
) {
  return function fileFilter(
    _req: Request,
    file: Express.Multer.File,
    cb: FileFilterCallback
  ): void {
    const extension = path
      .extname(file.originalname)
      .toLowerCase();

    const mimeAllowed =
      allowedMimeTypes.includes(file.mimetype);

    const extensionAllowed =
      allowedExtensions.includes(extension);

    if (!mimeAllowed || !extensionAllowed) {
      return cb(new Error(rejectionMessage));
    }

    /*
     * Multer's fileFilter runs before the complete file buffer
     * is available, so magic-byte validation is performed by
     * the route after multer has parsed the file.
     */

    cb(null, true);
  };
}

/* ---------------- FILTERS ---------------- */

const imageFileFilter = makeFileFilter(
  IMAGE_MIME_TYPES,
  IMAGE_EXTENSIONS,
  "Only JPEG, PNG, WebP, and GIF image files are allowed"
);

const catalogFileFilter = makeFileFilter(
  CATALOG_MIME_TYPES,
  CATALOG_EXTENSIONS,
  "Unsupported file type. Upload a CSV, Excel, PDF, Word, or text file."
);

/* ---------------- MULTER FACTORY ---------------- */

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
      files: 1,
    },

    fileFilter: options?.fileFilter ?? imageFileFilter,
  });
}

/* ---------------- READY-TO-USE EXPORTS ---------------- */

export const localUpload = getMulterForMode("local");

export const cloudUpload = getMulterForMode("cloud");

export const catalogUpload = getMulterForMode("cloud", {
  fileFilter: catalogFileFilter,
  maxFileSize: MAX_CATALOG_FILE_SIZE,
});