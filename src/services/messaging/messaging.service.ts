import { sendTelegramMessage } from "./telegram.service";
import { sendWhatsAppMessage } from "./whatsapp.service";

export const sendMessage = async (
  platform: string,
  sellerId: number,
  recipientId: string,
  text: string
) => {
  switch (platform) {
    case "TELEGRAM":
      return sendTelegramMessage(
        sellerId,
        recipientId,
        text
      );

    case "WHATSAPP":
      return sendWhatsAppMessage({
        sellerId,
        recipientId,
        text,
      });

    default:
      throw new Error(
        `Unsupported platform: ${platform}`
      );
  }
};