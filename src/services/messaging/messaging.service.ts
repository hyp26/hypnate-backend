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
      throw new Error("WhatsApp messaging not implemented yet");

    default:
      throw new Error(
        `Unsupported platform: ${platform}`
      );
  }
};