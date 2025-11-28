import multer from "multer";
import path from "path";
import fs from "fs";

const uploadsDir = process.env.UPLOADS_DIR || "./uploads";
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// disk storage for local mode
const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = `${Date.now()}-${Math.round(Math.random()*1e9)}${ext}`;
    cb(null, name);
  }
});

// memory storage for cloud mode (we'll upload buffer to Cloudinary)
const memoryStorage = multer.memoryStorage();

const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 5_242_880); // 5MB default

// file filter (images only)
function imageFileFilter(req: Express.Request, file: Express.Multer.File, cb: any) {
  const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  if (!allowed.includes(file.mimetype)) {
    return cb(new Error("Only image files (jpeg, png, webp, gif) are allowed"));
  }
  cb(null, true);
}

// factory to pick storage mode
export function getMulterForMode(mode: "local" | "cloud") {
  return multer({
    storage: mode === "local" ? diskStorage : memoryStorage,
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: imageFileFilter,
  });
}
