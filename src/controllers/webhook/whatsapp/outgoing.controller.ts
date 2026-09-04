import { Request, Response } from "express";
import { logger } from "../../../utils/logger";

export const sendMessage = async (
  req: Request,
  res: Response
): Promise<Response> => {
  try {
    const {
      phoneNumber,
      message,
    } = req.body;

    return res.status(200).json({
      success: true,
      message: "Message queued",
    });
  } catch (error) {
    logger.error("WhatsApp outgoing message failed", error);

    return res.status(500).json({
      success: false,
      message: "Failed to send message",
    });
  }
};