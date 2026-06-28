import { Request, Response } from "express";

export const connectWhatsApp = async (
  req: Request,
  res: Response
) => {
  const sellerId = req.query.sellerId;

  const url =
    `https://www.facebook.com/v23.0/dialog/oauth` +
    `?client_id=${process.env.META_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(
      process.env.META_REDIRECT_URI!
    )}` +
    `&state=${sellerId}` +
    `&scope=` +
    [
      "business_management",
      "whatsapp_business_management",
      "whatsapp_business_messaging"
    ].join(",");

  return res.redirect(url);
};