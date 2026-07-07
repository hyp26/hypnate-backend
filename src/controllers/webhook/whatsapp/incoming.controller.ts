import { Request, Response } from "express";

export const receiveMessage = async (
  req: Request,
  res: Response
): Promise<Response> => {
  console.log("🔥 WhatsApp webhook hit");
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;

if (!value) {
  return res.sendStatus(200);
}

const message = value.messages?.[0];

if (!message) {
  return res.sendStatus(200);
}

const contact = value.contacts?.[0];

const phoneNumberId =
  value.metadata?.phone_number_id;

const customerPhone = message.from;

const customerName =
  contact?.profile?.name ?? "Unknown";

const text =
  message.text?.body ?? "";

const externalMessageId =
  message.id;

const timestamp = new Date(
  Number(message.timestamp) * 1000
);

console.log({
  phoneNumberId,
  customerPhone,
  customerName,
  text,
  externalMessageId,
  timestamp,
});

return res.sendStatus(200);
  } catch (error) {
    console.error(error);
    return res.sendStatus(500);
  }
};