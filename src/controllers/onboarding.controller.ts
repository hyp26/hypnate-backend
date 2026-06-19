import { Response, NextFunction } from "express";
import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";
import { encrypt } from "../services/crypto.service";
import Papa from "papaparse";

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
    if (!sellerId) return res.status(403).json({ message: "Seller account required" });

    const { businessName, industry, size, phone, gstNumber } = req.body;

    if (!businessName || businessName.trim().length < 2) {
      return res.status(400).json({ message: "Business name must be at least 2 characters" });
    }

    const seller = await prisma.seller.update({
      where: { id: sellerId },
      data: {
        businessName: businessName.trim(),
        ...(phone && { phone }),
        ...(gstNumber && { gstNumber }),
        ...(industry && { industry }),
        ...(size && { businessSize: size }),
      },
    });

    return res.json({ message: "Business info saved", seller });
  } catch (err) {
    next(err);
  }
};

/* ─────────────────────────────────────────────
   POST /api/onboarding/catalog
   Parse CSV / converted-xlsx and bulk-import products
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

    const firstRow = data[0] as any;
    const missingCols = ["name", "price"].filter((c) => !(c in firstRow));
    if (missingCols.length > 0) {
      return res.status(400).json({
        message: `CSV is missing required columns: ${missingCols.join(", ")}`,
        hint: "Required: name, price. Optional: description, category, stock, image_url",
      });
    }

    const products = (data as any[])
      .map((row) => {
        const price = parseFloat(row.price);
        const name = String(row.name || "").trim();
        if (!name || isNaN(price) || price < 0) return null;
        return {
          sellerId,
          name,
          description: row.description ? String(row.description).trim() : null,
          category: row.category ? String(row.category).trim() : null,
          price,
          stock: parseInt(row.stock) || 0,
          imageUrl: row.image_url || row.imageurl || row.image || null,
        };
      })
      .filter(Boolean) as any[];

    if (products.length === 0) {
      return res.status(400).json({ message: "No valid products found in CSV" });
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
   POST /api/onboarding/payments
   Supports all gateways: razorpay, payu, cashfree, skydo, cod
───────────────────────────────────────────── */
export const savePaymentKeys = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = req.user?.sellerId;
    if (!sellerId) return res.status(403).json({ message: "Seller account required" });

    const { gateway, keyId, keySecret, merchantId, salt } = req.body;

    if (!gateway) {
      return res.status(400).json({ message: "Gateway is required" });
    }

    const SUPPORTED = ["razorpay", "payu", "cashfree", "skydo", "cod"];
    if (!SUPPORTED.includes(gateway)) {
      return res.status(400).json({ message: `Unsupported gateway: ${gateway}` });
    }

    // COD needs no keys
    if (gateway === "cod") {
      await prisma.seller.update({
        where: { id: sellerId },
        data: { paymentGateway: "cod" },
      });
      return res.json({ message: "Cash on Delivery enabled" });
    }

    // Resolve key fields per gateway
    const resolvedKeyId = keyId || merchantId || "";
    const resolvedKeySecret = keySecret || salt || "";

    if (!resolvedKeyId || !resolvedKeySecret) {
      return res.status(400).json({ message: "Both key fields are required for this gateway" });
    }

    // Gateway-specific validation
    if (gateway === "razorpay" && !resolvedKeyId.startsWith("rzp_")) {
      return res.status(400).json({ message: "Invalid Razorpay Key ID — must start with rzp_" });
    }

    if (resolvedKeyId.length < 8 || resolvedKeySecret.length < 8) {
      return res.status(400).json({ message: "Keys appear too short — please double check" });
    }

    // Store on Seller — in production, encrypt resolvedKeySecret with AES-256
    // e.g. const encrypted = encrypt(resolvedKeySecret, process.env.ENCRYPTION_KEY)
  await prisma.seller.update({
    where: { id: sellerId },
    data: {
      paymentGateway: gateway,
      gatewayKeyId: resolvedKeyId,
      gatewayKeySecret: encrypt(resolvedKeySecret),
     },
  });

    return res.json({ message: `${gateway} payment gateway configured successfully` });
  } catch (err) {
    next(err);
  }
};

/* ─────────────────────────────────────────────
   POST /api/onboarding/channels
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

    const updateData: any = {};

    /* ---------- WhatsApp ---------- */
    if (channels.whatsapp) {
      if (
        !channels.whatsapp.phone ||
        !channels.whatsapp.apiKey
      ) {
        return res.status(400).json({
          message: "WhatsApp requires phone and API key",
        });
      }

      updateData.waPhone = channels.whatsapp.phone;

      // ✅ Encrypt before storing
      updateData.waApiKey = encrypt(
        channels.whatsapp.apiKey
      );
    }

    /* ---------- Telegram ---------- */
    if (channels.telegram) {
      if (
        !channels.telegram.botToken ||
        !channels.telegram.botToken.includes(":")
      ) {
        return res.status(400).json({
          message: "Invalid Telegram bot token format",
        });
      }

      // ✅ Encrypt before storing
      updateData.tgBotToken = encrypt(
        channels.telegram.botToken
      );
    }

    if (Object.keys(updateData).length > 0) {
      await prisma.seller.update({
        where: { id: sellerId },
        data: updateData,
      });
    }

    return res.json({
      message: "Channels saved",
      connected: Object.keys(channels),
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
    if (!sellerId) return res.status(403).json({ message: "Seller account required" });

    await prisma.seller.update({
      where: { id: sellerId },
      data: { onboardedAt: new Date() },
    });

    return res.json({ message: "Onboarding complete", redirect: "/dashboard" });
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
    if (!sellerId) return res.status(403).json({ message: "Seller account required" });

    const seller = await prisma.seller.findUnique({
      where: { id: sellerId },
    });
    if (!seller) return res.status(404).json({ message: "Seller not found" });

    const productCount = await prisma.product.count({ where: { sellerId } });

    const connectedChannels = await prisma.channelConnection.count({
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
    });
  } catch (err) {
    next(err);
  }
};

/* ─────────────────────────────────────────────
   GET /api/onboarding/me
   Returns existing onboarding data (for prefill)
───────────────────────────────────────────── */
export const getOnboardingData = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = req.user?.sellerId;

    if (!sellerId) {
      return res.status(403).json({ message: "Seller account required" });
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
      return res.status(404).json({ message: "Seller not found" });
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