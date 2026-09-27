import { Request, Response, NextFunction } from "express";
import prisma from "../prisma/client";
import { dataDeletionRequestSchema } from "../schemas/deletion-request.schema";
import { logger } from "../utils/logger";

/*
 * Public data-deletion request intake (Meta privacy compliance).
 *
 * SECURITY:
 * - No account lookup happens here, so this endpoint never
 *   reveals whether an account exists and never deletes data
 *   on its own. It only records a PENDING request which Hypnate
 *   processes manually after verifying the requester out-of-band.
 * - The schema is strict: callers cannot supply account/user IDs.
 * - Only the request ID is logged. Personal data is not logged
 *   (the shared logger also redacts emails/phones defensively).
 */
export const submitDataDeletionRequest = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const parsed = dataDeletionRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        success: false,
        message: "Invalid data deletion request",
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { contactEmail, details } = parsed.data;

    const deletionRequest = await prisma.deletionRequest.create({
      data: {
        contactEmail,
        details: details || null,
      },
      select: {
        id: true,
      },
    });

    logger.info("Data deletion request received", {
      deletionRequestId: deletionRequest.id,
    });

    /*
     * Always the same generic response, regardless of whether a
     * matching account exists. Actual deletion happens only after
     * Hypnate verifies the request through the contact details
     * provided.
     */
    res.status(201).json({
      success: true,
      message:
        "Your deletion request has been received. If additional verification is required, Hypnate will contact you using the information provided.",
    });
  } catch (error) {
    next(error);
  }
};
