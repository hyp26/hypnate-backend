import { Request, Response } from "express";

export const messageStatus = async (
  req: Request,
  res: Response
): Promise<Response> => {
  try {
    console.log(
      "WhatsApp Status Update:",
      JSON.stringify(req.body, null, 2)
    );

    return res.sendStatus(200);
  } catch (error) {
    console.error(error);

    return res.sendStatus(500);
  }
};