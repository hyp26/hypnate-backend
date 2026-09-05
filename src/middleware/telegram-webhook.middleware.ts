import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import prisma from "../prisma/client";
import { decrypt } from "../services/crypto.service";

export const verifyTelegramWebhookSecret = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const sellerId = Number(req.params.sellerId);

    if (!Number.isInteger(sellerId) || sellerId <= 0) {
      return res.sendStatus(401);
    }

    const suppliedSecret =
      req.header("X-Telegram-Bot-Api-Secret-Token");

    if (
      typeof suppliedSecret !== "string" ||
      suppliedSecret.length === 0
    ) {
      return res.sendStatus(401);
    }

    const connection =
      await prisma.channelConnection.findFirst({
        where: {
          sellerId,
          platform: "TELEGRAM",
          isActive: true,
        },
        select: {
          webhookSecret: true,
        },
      });

    if (!connection?.webhookSecret) {
      return res.sendStatus(401);
    }

    let expectedSecret: string;

    try {
      expectedSecret = decrypt(connection.webhookSecret);
    } catch {
      return res.sendStatus(401);
    }

    const suppliedBuffer = Buffer.from(
      suppliedSecret,
      "utf8"
    );

    const expectedBuffer = Buffer.from(
      expectedSecret,
      "utf8"
    );

    if (
      suppliedBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(
        suppliedBuffer,
        expectedBuffer
      )
    ) {
      return res.sendStatus(401);
    }

    return next();
  } catch {
    return res.sendStatus(401);
  }
};