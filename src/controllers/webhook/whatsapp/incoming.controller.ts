import { Request, Response } from "express";

export const receiveMessage = async (
  req: Request,
  res: Response
): Promise<Response> => {
  try {
    console.log(
      "Incoming WhatsApp Webhook:",
      JSON.stringify(req.body, null, 2)
    );

    const entry = req.body?.entry?.[0];

    if (!entry) {
      return res.sendStatus(200);
    }

    const change = entry?.changes?.[0];

    const message =
      change?.value?.messages?.[0];

    if (!message) {
      return res.sendStatus(200);
    }

    const customerId = message.from;

    const content =
      message?.text?.body || "";

    const timestamp =
      message?.timestamp;

    console.log({
      customerId,
      content,
      timestamp,
    });

    return res.sendStatus(200);
  } catch (error) {
    console.error(error);

    return res.sendStatus(500);
  }
};