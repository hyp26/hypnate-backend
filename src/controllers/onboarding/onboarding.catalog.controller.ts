import { Response, NextFunction } from "express";
import prisma from "../../prisma/client";
import { AuthRequest } from "../../middleware/authMiddleware";
import { parseStructuredCatalog } from "../../services/catalog/parseStructuredFile";
import { extractTextFromFile } from "../../services/catalog/extractText";
import { extractProductsWithAI } from "../../services/catalog/aiExtractProducts";

const STRUCTURED_MIME = new Set([
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const MAX_PRODUCTS = 500; // matches the limit the frontend already states

export const uploadCatalogFile = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!req.user?.sellerId)
      return res.status(400).json({ message: "No seller account linked to this user" });

    const file = req.file;
    if (!file)
      return res.status(400).json({ message: "No file uploaded" });

    const rows = STRUCTURED_MIME.has(file.mimetype)
      ? parseStructuredCatalog(file.buffer)
      : await (async () => {
          const text = await extractTextFromFile(file.buffer, file.mimetype);
          if (!text.trim()) {
            throw Object.assign(new Error("Couldn't read any text from that file"), { status: 400 });
          }
          return extractProductsWithAI(text);
        })();

    if (rows.length === 0)
      return res.status(422).json({ message: "No products could be found in that file" });

    const capped = rows.slice(0, MAX_PRODUCTS);

    await prisma.product.createMany({
      data: capped.map((r) => ({
        sellerId: req.user!.sellerId!,
        name: r.name,
        price: r.price,
        description: r.description,
        category: r.category,
        stock: r.stock ?? 0,
      })),
    });

    // NOTE: not writing an Upload row here — that model's `url` field
    // expects the file to actually be archived somewhere (S3/Cloudinary).
    // You already have utils/cloudinary.ts in this project; if you want the
    // original file kept, upload `file.buffer` through that helper here and
    // use its returned URL for the Upload record. Left out to avoid writing
    // an Upload row with a fake/empty url.

    return res.status(200).json({ message: "Catalog imported", count: capped.length });
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    next(err);
  }
};