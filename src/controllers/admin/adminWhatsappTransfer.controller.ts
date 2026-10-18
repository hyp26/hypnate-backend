import { Request, Response } from "express";
import { AdminAuthRequest } from "../../middleware/adminAuth.middleware";
import {
  applyTransfer,
  dryRunTransfer,
  TransferAbortError,
} from "../../services/whatsappOwnershipTransfer.service";
import { logger } from "../../utils/logger";

/*
 * Admin endpoints for WhatsApp connection-ownership transfers.
 *
 * The dry run is strictly read-only. The apply endpoint REQUIRES
 * an explicit `confirm: true` in the body plus a SUPER_ADMIN
 * role; it never runs implicitly and no seller IDs are
 * hardcoded.
 */

const readSellerIds = (body: unknown) => {
  if (!body || typeof body !== "object") {
    return null;
  }

  const record = body as Record<string, unknown>;

  const source = Number(record.sourceSellerId);
  const destination = Number(record.destinationSellerId);

  if (
    !Number.isInteger(source) ||
    !Number.isInteger(destination) ||
    source <= 0 ||
    destination <= 0
  ) {
    return null;
  }

  return { sourceSellerId: source, destinationSellerId: destination };
};

export const whatsappTransferDryRun = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const adminReq = req as AdminAuthRequest;

    const actorAdminId = adminReq.adminUser?.id;

    const sellerIds = readSellerIds(req.body);

    if (!sellerIds) {
      res.status(400).json({
        message:
          "sourceSellerId and destinationSellerId are required",
      });

      return;
    }

    const report = await dryRunTransfer({
      ...sellerIds,
      actorAdminId,
    });

    res.json({
      success: true,
      report,
    });
  } catch (err) {
    logger.error(
      "WhatsApp transfer dry run failed",
      err
    );

    res.status(500).json({
      message: "WhatsApp transfer dry run failed",
    });
  }
};

export const whatsappTransferApply = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const adminReq = req as AdminAuthRequest;

    const actorAdminId = adminReq.adminUser?.id;

    const sellerIds = readSellerIds(req.body);

    const confirm =
      !!req.body &&
      typeof req.body === "object" &&
      (req.body as Record<string, unknown>).confirm === true;

    if (!sellerIds) {
      res.status(400).json({
        message:
          "sourceSellerId and destinationSellerId are required",
      });

      return;
    }

    if (!confirm) {
      res.status(400).json({
        message:
          "Pass confirm: true to apply a WhatsApp ownership transfer",
      });

      return;
    }

    const io = req.app.get("io");

    const result = await applyTransfer({
      ...sellerIds,
      confirm,
      actorAdminId,
      io,
    });

    res.json({
      success: true,
      result,
    });
  } catch (err) {
    if (err instanceof TransferAbortError) {
      logger.warn(
        "WhatsApp transfer aborted:",
        err.code
      );

      res.status(409).json({
        success: false,
        code: err.code,
        message: err.message,
        details: err.details ?? null,
      });

      return;
    }

    logger.error(
      "WhatsApp transfer apply failed",
      err
    );

    res.status(500).json({
      message: "WhatsApp transfer failed",
    });
  }
};
