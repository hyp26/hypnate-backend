import { Response, NextFunction } from "express";
import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";
import { encrypt } from "../services/crypto.service";
import Papa from "papaparse";
import { parseStructuredCatalog } from "../services/catalog/parseStructuredFile";
import { extractTextFromFile } from "../services/catalog/extractText";
import { extractProductsWithAI } from "../services/catalog/aiExtractProducts";

/* ─────────────────────────────────────────────
   POST /api/onboarding/business
   ───────────────────────────────────────────── */
export const saveBusinessInfo = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = req.user?.sellerId;

    if (!sellerId) {
      return res.status(403).json({
        message: "Seller account required",
      });
    }

    const {
      businessName,
      industry,
      size,
      phone,
      gstNumber,
    } = req.body;

    if (
      !businessName ||
      typeof businessName !== "string" ||
      businessName.trim().length < 2
    ) {
      return res.status(400).json({
        message: "Business name must be at least 2 characters",
      });
    }

    const seller = await prisma.seller.update({
      where: { id: sellerId },
      data: {
        businessName: businessName.trim(),

        ...(phone &&
          typeof phone === "string" && {
            phone: phone.trim(),
          }),

        ...(gstNumber &&
          typeof gstNumber === "string" && {
            gstNumber: gstNumber.trim(),
          }),

        ...(industry &&
          typeof industry === "string" && {
            industry: industry.trim(),
          }),

        ...(size &&
          typeof size === "string" && {
            businessSize: size.trim(),
          }),
      },
    });

    return res.json({
      message: "Business info saved",
      seller,
    });
  } catch (err) {
    next(err);
  }
};

/* ─────────────────────────────────────────────
   POST /api/onboarding/catalog

   Legacy JSON-body CSV import.
   ───────────────────────────────────────────── */
export const uploadCatalog = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = req.user?.sellerId;

    if (!sellerId) {
      return res.status(403).json({
        message: "Seller account required",
      });
    }

    const csvText = req.body.csvData as string;

    if (!csvText || typeof csvText !== "string") {
      return res.status(400).json({
        message: "No CSV data provided",
      });
    }

    const { data, errors } = Papa.parse(csvText, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (header) =>
        header.trim().toLowerCase().replace(/\s+/g, "_"),
    });

    if (errors.length > 0) {
      return res.status(400).json({
        message: "Invalid CSV format",
        errors,
      });
    }

    if (data.length === 0) {
      return res.status(400).json({
        message: "CSV is empty",
      });
    }

    if (data.length > 500) {
      return res.status(400).json({
        message: "CSV must contain 500 products or fewer",
      });
    }

    const firstRow = data[0] as Record<string, unknown>;

    const missingCols = ["name", "price"].filter(
      (column) => !(column in firstRow)
    );

    if (missingCols.length > 0) {
      return res.status(400).json({
        message: `CSV is missing required columns: ${missingCols.join(", ")}`,
        hint:
          "Required: name, price. Optional: description, category, stock, image_url",
      });
    }

    const products = (data as Record<string, unknown>[]).flatMap(
      (row) => {
        const rawPrice = row.price;

        const price =
          typeof rawPrice === "number"
            ? rawPrice
            : parseFloat(String(rawPrice ?? ""));

        const name = String(row.name || "").trim();

        if (!name || Number.isNaN(price) || price < 0) {
          return [];
        }

        const rawStock = row.stock;

        const parsedStock = Number.parseInt(
          String(rawStock ?? "0"),
          10
        );

        const stock = Number.isNaN(parsedStock)
          ? 0
          : parsedStock;

        const rawImageUrl =
          row.image_url ||
          row.imageurl ||
          row.image ||
          null;

        const imageUrl =
          typeof rawImageUrl === "string"
            ? rawImageUrl.trim() || null
            : null;

        return [
          {
            sellerId,
            name,
            description: row.description
              ? String(row.description).trim()
              : null,
            category: row.category
              ? String(row.category).trim()
              : null,
            price,
            stock,
            imageUrl,
          },
        ];
      }
    );

    if (products.length === 0) {
      return res.status(400).json({
        message: "No valid products found in CSV",
      });
    }

    const created = await prisma.product.createMany({
      data: products,
      skipDuplicates: true,
    });

    return res.json({
      message: `${created.count} products imported successfully`,
      total: products.length,
      imported: created.count,
      skipped: products.length - created.count,
    });
  } catch (err) {
    next(err);
  }
};

/* ─────────────────────────────────────────────
   POST /api/onboarding/catalog-file

   Multipart CSV/XLSX import.

   PDF/DOCX/TXT files are processed through
   text extraction + AI product extraction.
   ───────────────────────────────────────────── */

const STRUCTURED_MIME = new Set([
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const MAX_PRODUCTS = 500;

export const uploadCatalogFile = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = req.user?.sellerId;

    if (!sellerId) {
      return res.status(403).json({
        message: "Seller account required",
      });
    }

    const file = req.file;

    if (!file) {
      return res.status(400).json({
        message: "No file uploaded",
      });
    }

    const rows = STRUCTURED_MIME.has(file.mimetype)
      ? parseStructuredCatalog(file.buffer)
      : await (async () => {
          const text = await extractTextFromFile(
            file.buffer,
            file.mimetype
          );

          if (!text.trim()) {
            throw Object.assign(
              new Error(
                "Couldn't read any text from that file"
              ),
              { status: 400 }
            );
          }

          return extractProductsWithAI(text);
        })();

    if (rows.length === 0) {
      return res.status(422).json({
        message: "No products could be found in that file",
      });
    }

    const capped = rows.slice(0, MAX_PRODUCTS);

    const created = await prisma.product.createMany({
      data: capped.map((row) => ({
        sellerId,
        name: row.name,
        price: row.price,
        description: row.description ?? null,
        category: row.category ?? null,
        stock: row.stock ?? 0,
      })),
      skipDuplicates: true,
    });

    return res.status(200).json({
      message: `${created.count} products imported successfully`,
      total: capped.length,
      imported: created.count,
    });
  } catch (err: any) {
    if (err?.status) {
      return res.status(err.status).json({
        message: err.message,
      });
    }

    next(err);
  }
};

/* ─────────────────────────────────────────────
   POST /api/onboarding/payments

   Supports:
   razorpay
   payu
   cashfree
   skydo
   cod
   ───────────────────────────────────────────── */
export const savePaymentKeys = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = req.user?.sellerId;

    if (!sellerId) {
      return res.status(403).json({
        message: "Seller account required",
      });
    }

    const {
      gateway,
      keyId,
      keySecret,
      merchantId,
      salt,
    } = req.body;

    if (!gateway || typeof gateway !== "string") {
      return res.status(400).json({
        message: "Gateway is required",
      });
    }

    const SUPPORTED = [
      "razorpay",
      "payu",
      "cashfree",
      "skydo",
      "cod",
    ];

    if (!SUPPORTED.includes(gateway)) {
      return res.status(400).json({
        message: `Unsupported gateway: ${gateway}`,
      });
    }

    /* ---------- COD ---------- */

    if (gateway === "cod") {
      await prisma.seller.update({
        where: { id: sellerId },
        data: {
          paymentGateway: "cod",
        },
      });

      return res.json({
        message: "Cash on Delivery enabled",
      });
    }

    /* ---------- Gateway credentials ---------- */

    const resolvedKeyId =
      typeof keyId === "string" && keyId.trim()
        ? keyId.trim()
        : typeof merchantId === "string"
          ? merchantId.trim()
          : "";

    const resolvedKeySecret =
      typeof keySecret === "string" && keySecret.trim()
        ? keySecret.trim()
        : typeof salt === "string"
          ? salt.trim()
          : "";

    if (!resolvedKeyId || !resolvedKeySecret) {
      return res.status(400).json({
        message:
          "Both key fields are required for this gateway",
      });
    }

    /* ---------- Razorpay validation ---------- */

    if (
      gateway === "razorpay" &&
      !resolvedKeyId.startsWith("rzp_")
    ) {
      return res.status(400).json({
        message:
          "Invalid Razorpay Key ID — must start with rzp_",
      });
    }

    if (
      resolvedKeyId.length < 8 ||
      resolvedKeySecret.length < 8
    ) {
      return res.status(400).json({
        message:
          "Keys appear too short — please double check",
      });
    }

    /* ---------- Secure storage ---------- */

    await prisma.seller.update({
      where: { id: sellerId },
      data: {
        paymentGateway: gateway,
        gatewayKeyId: resolvedKeyId,
        gatewayKeySecret: encrypt(resolvedKeySecret),
      },
    });

    return res.json({
      message:
        `${gateway} payment gateway configured successfully`,
    });
  } catch (err) {
    next(err);
  }
};

/* ─────────────────────────────────────────────
   POST /api/onboarding/channels

   LEGACY ENDPOINT

   WhatsApp and Telegram credentials are no
   longer stored directly on Seller.

   Channel connections are managed through
   ChannelConnection and their dedicated flows.
   ───────────────────────────────────────────── */
export const saveChannels = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = req.user?.sellerId;

    if (!sellerId) {
      return res.status(403).json({
        message: "Seller account required",
      });
    }

    const { channels } = req.body;

    if (!channels || typeof channels !== "object") {
      return res.status(400).json({
        message: "channels object required",
      });
    }

    const requestedChannels = Object.keys(channels);

    if (requestedChannels.length === 0) {
      return res.status(400).json({
        message: "At least one channel is required",
      });
    }

    /*
     * Channel credentials are intentionally NOT stored on Seller.
     *
     * Telegram and WhatsApp connections are managed through
     * ChannelConnection and their dedicated channel controllers.
     *
     * This endpoint is retained only as an onboarding compatibility
     * endpoint and does not accept or persist raw channel secrets.
     */
    const unsupportedChannels = requestedChannels.filter(
      (channel) =>
        channel !== "telegram" &&
        channel !== "whatsapp"
    );

    if (unsupportedChannels.length > 0) {
      return res.status(400).json({
        message: "Unsupported channel",
      });
    }

    return res.status(410).json({
      message:
        "Channel setup has moved to the dedicated channel connection flow.",
      channels: requestedChannels,
    });
  } catch (err) {
    next(err);
  }
};

/* ─────────────────────────────────────────────
   POST /api/onboarding/complete
   ───────────────────────────────────────────── */
export const completeOnboarding = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = req.user?.sellerId;

    if (!sellerId) {
      return res.status(403).json({
        message: "Seller account required",
      });
    }

    await prisma.seller.update({
      where: { id: sellerId },
      data: {
        onboardedAt: new Date(),
      },
    });

    return res.json({
      message: "Onboarding complete",
      redirect: "/dashboard",
    });
  } catch (err) {
    next(err);
  }
};

/* ─────────────────────────────────────────────
   GET /api/onboarding/status
   ───────────────────────────────────────────── */
export const getOnboardingStatus = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = req.user?.sellerId;

    if (!sellerId) {
      return res.status(403).json({
        message: "Seller account required",
      });
    }

    const seller = await prisma.seller.findUnique({
      where: { id: sellerId },
    });

    if (!seller) {
      return res.status(404).json({
        message: "Seller not found",
      });
    }

    const productCount = await prisma.product.count({
      where: { sellerId },
    });

    const connectedChannels =
      await prisma.channelConnection.count({
        where: {
          sellerId,
          isActive: true,
        },
      });

    return res.json({
      businessInfo: !!seller.businessName,
      catalog: productCount > 0,
      payments: !!seller.paymentGateway,
      onboarded: !!seller.onboardedAt,
      productCount,
      gateway: seller.paymentGateway || null,
      connectedChannels,
    });
  } catch (err) {
    next(err);
  }
};

/* ─────────────────────────────────────────────
   GET /api/onboarding/me

   Returns existing onboarding data for prefill.
   ───────────────────────────────────────────── */
export const getOnboardingData = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = req.user?.sellerId;

    if (!sellerId) {
      return res.status(403).json({
        message: "Seller account required",
      });
    }

    const seller = await prisma.seller.findUnique({
      where: { id: sellerId },
      select: {
        businessName: true,
        phone: true,
        gstNumber: true,
        industry: true,
        businessSize: true,
      },
    });

    if (!seller) {
      return res.status(404).json({
        message: "Seller not found",
      });
    }

    return res.json({
      businessName: seller.businessName || "",
      phone: seller.phone || "",
      gstNumber: seller.gstNumber || "",
      industry: seller.industry || "",
      size: seller.businessSize || "",
    });
  } catch (err) {
    next(err);
  }
};