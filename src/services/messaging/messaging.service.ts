import { sendTelegramMessage } from "./telegram.service";
import { sendWhatsAppMessageForSeller } from "./whatsapp.service";

export const sendMessage = async (
  platform: string,
  sellerId: number,
  recipientId: string,
  text: string,
  channelId?: string
) => {
  switch (platform.toUpperCase()) {
    case "TELEGRAM":
      return sendTelegramMessage(
        sellerId,
        recipientId,
        text
      );

    case "WHATSAPP":
      return sendWhatsAppMessageForSeller(
        sellerId,
        recipientId,
        text,
        channelId
      );

    default:
      throw new Error(
        `Unsupported platform: ${platform}`
      );
  }
};
