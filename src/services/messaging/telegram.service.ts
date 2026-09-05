import axios from "axios";
import prisma from "../../prisma/client";
import { decrypt } from "../crypto.service";

const getBotToken = async (
  sellerId: number
): Promise<string> => {
  const connection =
    await prisma.channelConnection.findFirst({
      where: {
        sellerId,
        platform: "TELEGRAM",
        isActive: true,
      },
    });

  if (!connection?.accessToken) {
    throw new Error(
      "No active Telegram connection found"
    );
  }

  return decrypt(connection.accessToken);
};

export const sendTelegramMessage = async (
  sellerId: number,
  chatId: string,
  text: string
) => {
  const botToken =
    await getBotToken(sellerId);

  const response = await axios.post(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      chat_id: chatId,
      text,
    }
  );

  return response.data;
};

export const setTelegramWebhook = async (
  sellerId: number,
  webhookUrl: string,
  webhookSecret: string
) => {
  const botToken =
    await getBotToken(sellerId);

  const response = await axios.post(
    `https://api.telegram.org/bot${botToken}/setWebhook`,
    {
      url: webhookUrl,
      secret_token: webhookSecret,
    }
  );

  return response.data;
};

export const getTelegramBotInfo = async (
  sellerId: number
) => {
  const botToken =
    await getBotToken(sellerId);

  const response = await axios.get(
    `https://api.telegram.org/bot${botToken}/getMe`
  );

  return response.data;
};