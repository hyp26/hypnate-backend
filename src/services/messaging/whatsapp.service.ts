import { SendMessageParams } from "./types";

export const sendWhatsAppMessage = async ({
  sellerId,
  recipientId,
  text,
}: SendMessageParams) => {
  throw new Error(
    "WhatsApp not implemented yet"
  );
};