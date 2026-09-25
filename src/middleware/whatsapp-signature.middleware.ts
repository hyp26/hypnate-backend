import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { ENV } from "../config/env";

type RawBodyRequest = Request & {
  rawBody?: Buffer;
};

export const verifyWhatsAppSignature = (
  req: RawBodyRequest,
  res: Response,
  next: NextFunction
): void => {
  const appSecret = ENV.META_APP_SECRET;

  if (!appSecret) {
    /*
     * Never accept unauthenticated WhatsApp webhooks in production.
     */
    res.status(500).json({
      success: false,
      message: "WhatsApp webhook is not configured",
    });
    return;
  }

  const signature = req.header("X-Hub-Signature-256");

  if (!signature) {
    res.sendStatus(401);
    return;
  }

  const expectedPrefix = "sha256=";

  if (!signature.startsWith(expectedPrefix)) {
    res.sendStatus(401);
    return;
  }

  const receivedSignature = signature.slice(
    expectedPrefix.length
  );

  if (!/^[a-fA-F0-9]{64}$/.test(receivedSignature)) {
    res.sendStatus(401);
    return;
  }

  const rawBody = req.rawBody;

  if (!rawBody) {
    res.status(400).json({
      success: false,
      message: "Invalid webhook payload",
    });
    return;
  }

  const expectedSignature = crypto
    .createHmac("sha256", appSecret)
    .update(rawBody)
    .digest("hex");

  const receivedBuffer = Buffer.from(
    receivedSignature,
    "hex"
  );

  const expectedBuffer = Buffer.from(
    expectedSignature,
    "hex"
  );

  if (
    receivedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(
      receivedBuffer,
      expectedBuffer
    )
  ) {
    res.sendStatus(401);
    return;
  }

  next();
};
