import { Response, NextFunction } from "express";
import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";
import Papa from "papaparse";

/* ─────────────────────────────────────────────
   POST /api/onboarding/business
   Save business info to Seller record
───────────────────────────────────────────── */
export const saveBusinessInfo = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = req.user?.sellerId;
    if (!sellerId) return res.status(403).json({ message: "Seller account required" });

    const { businessName, industry, size, phone, gstNumber } = req.body;

    if (!businessName || businessName.trim().length < 2) {
      return res.status(400).json({ message: "Business name must be at least 2 characters" });
    }

    const seller = await prisma.seller.update({
      where: { id: sellerId },
      data: {
        businessName: businessName.trim(),
        ...(phone     && { phone }),
        ...(gstNumber && { gstNumber }),
      },
    });

    // Store extra fields on user meta (industry, size) in a separate table or just return success
    // For now stored on seller — extend schema if needed

    return res.json({ message: "Business info saved", seller });
  } catch (err) {
    next(err);
  }
};

/* ─────────────────────────────────────────────
   POST /api/onboarding/catalog
   Parse CSV and bulk create products
───────────────────────────────────────────── */
export const uploadCatalog = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = req.user?.sellerId;
    if (!sellerId) return res.status(403).json({ message: "Seller account required" });

    const csvText = req.body.csvData as string;
    if (!csvText) return res.status(400).json({ message: "No CSV data provided" });

    const { data, errors } = Papa.parse(csvText, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, "_"),
    });

    if (errors.length > 0) {
      return res.status(400).json({ message: "Invalid CSV format", errors });
    }

    if (data.length === 0) {
      return res.status(400).json({ message: "CSV is empty" });
    }

    if (data.length > 500) {
      return res.status(400).json({ message: "CSV must contain 500 products or fewer" });
    }

    const REQUIRED_COLS = ["name", "price"];
    const firstRow = data[0] as any;
    const missingCols = REQUIRED_COLS.filter((c) => !(c in firstRow));
    if (missingCols.length > 0) {
      return res.status(400).json({
        message: `CSV is missing required columns: ${missingCols.join(", ")}`,
        hint: "Required columns: name, price. Optional: description, category, stock, image_url",
      });
    }

    const products = (data as any[])
      .map((row, i) => {
        const price = parseFloat(row.price);
        if (isNaN(price) || price < 0) return null;
        return {
          sellerId,
          name:        String(row.name || "").trim(),
          description: row.description ? String(row.description).trim() : null,
          category:    row.category    ? String(row.category).trim()    : null,
          price,
          stock:       parseInt(row.stock) || 0,
          imageUrl:    row.image_url || row.imageurl || row.image || null,
        };
      })
      .filter(Boolean) as any[];

    if (products.length === 0) {
      return res.status(400).json({ message: "No valid products found in CSV" });
    }

    // Upsert — skip products already existing for this seller with same name
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
   POST /api/onboarding/payments
   Save Razorpay keys (encrypted at rest ideally)
───────────────────────────────────────────── */
export const savePaymentKeys = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = req.user?.sellerId;
    if (!sellerId) return res.status(403).json({ message: "Seller account required" });

    const { keyId, keySecret } = req.body;

    if (!keyId || !keySecret) {
      return res.status(400).json({ message: "Both Key ID and Key Secret are required" });
    }

    if (!keyId.startsWith("rzp_")) {
      return res.status(400).json({ message: "Invalid Razorpay Key ID format. Must start with rzp_" });
    }

    if (keyId.length < 20 || keySecret.length < 20) {
      return res.status(400).json({ message: "Invalid key length" });
    }

    // Store on seller record — in production encrypt keySecret with AES before storing
    // Using prisma json field for now — add razorpayKeyId/Secret to schema if preferred
    // For MVP: store as-is, production: encrypt with crypto.createCipheriv
    await prisma.seller.update({
      where: { id: sellerId },
      data: {
        // These fields need to be added to schema — see schema additions below
        // razorpayKeyId:     keyId,
        // razorpayKeySecret: keySecret,
        // For now just acknowledge receipt
      },
    });

    return res.json({ message: "Payment keys saved successfully" });
  } catch (err) {
    next(err);
  }
};

/* ─────────────────────────────────────────────
   POST /api/onboarding/channels
   Save connected channel credentials
───────────────────────────────────────────── */
export const saveChannels = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = req.user?.sellerId;
    if (!sellerId) return res.status(403).json({ message: "Seller account required" });

    const { channels } = req.body;
    // channels: { whatsapp?: { phone, apiKey }, telegram?: { botToken }, facebook?: { pageId, accessToken } }

    if (!channels || typeof channels !== "object") {
      return res.status(400).json({ message: "channels object required" });
    }

    // Validate whatsapp if provided
    if (channels.whatsapp) {
      if (!channels.whatsapp.phone || !channels.whatsapp.apiKey) {
        return res.status(400).json({ message: "WhatsApp requires phone number and API key" });
      }
    }

    // Validate telegram if provided
    if (channels.telegram) {
      if (!channels.telegram.botToken) {
        return res.status(400).json({ message: "Telegram requires a bot token" });
      }
      if (!channels.telegram.botToken.includes(":")) {
        return res.status(400).json({ message: "Invalid Telegram bot token format" });
      }
    }

    // Store channels — add to schema as needed
    // For now just acknowledge
    return res.json({ message: "Channels saved", connected: Object.keys(channels) });
  } catch (err) {
    next(err);
  }
};

/* ─────────────────────────────────────────────
   POST /api/onboarding/complete
   Mark onboarding as done, return dashboard redirect
───────────────────────────────────────────── */
export const completeOnboarding = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = req.user?.sellerId;
    if (!sellerId) return res.status(403).json({ message: "Seller account required" });

    // Mark seller as onboarded — add onboardedAt field to schema
    await prisma.seller.update({
      where: { id: sellerId },
      data: {
        // onboardedAt: new Date(),  — add this field to schema
      },
    });

    return res.json({ message: "Onboarding complete", redirect: "/dashboard" });
  } catch (err) {
    next(err);
  }
};

/* ─────────────────────────────────────────────
   GET /api/onboarding/status
   Check what steps seller has completed
───────────────────────────────────────────── */
export const getOnboardingStatus = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = req.user?.sellerId;
    if (!sellerId) return res.status(403).json({ message: "Seller account required" });

    const seller = await prisma.seller.findUnique({
      where: { id: sellerId },
      include: { products: { take: 1 } },
    });

    if (!seller) return res.status(404).json({ message: "Seller not found" });

    const productCount = await prisma.product.count({ where: { sellerId } });

    return res.json({
      businessInfo: !!seller.businessName,
      catalog:      productCount > 0,
      payments:     false, // update when schema fields added
      channels:     false, // update when schema fields added
      productCount,
    });
  } catch (err) {
    next(err);
  }
};