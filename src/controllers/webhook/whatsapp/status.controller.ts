import { Request, Response } from "express";
import { logger } from "../../../utils/logger";

export const messageStatus = async (
  _req: Request,
  res: Response
): Promise<Response> => {
  try {
    /*
     * WhatsApp status webhooks are acknowledged without logging
     * the provider payload because it may contain customer data.
     */
    logger.info("WhatsApp status webhook received");

    return res.sendStatus(200);
  } catch (error) {
    logger.error(
      "WhatsApp status webhook handling failed",
      error
    );

    return res.sendStatus(500);
  }
};