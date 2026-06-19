import { Request, Response } from "express";

export const sendMessage = async (
  req: Request,
  res: Response
): Promise<Response> => {
  try {
    const {
      phoneNumber,
      message,
    } = req.body;

    console.log({
      phoneNumber,
      message,
    });

    return res.status(200).json({
      success: true,
      message: "Message queued",
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message: "Failed to send message",
    });
  }
};