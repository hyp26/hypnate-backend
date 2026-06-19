import axios from "axios";

export const sendTelegramMessage = async (
  botToken: string,
  chatId: string,
  text: string
) => {
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
  botToken: string,
  webhookUrl: string
) => {
  const response = await axios.post(
    `https://api.telegram.org/bot${botToken}/setWebhook`,
    {
      url: webhookUrl,
    }
  );

  return response.data;
};

export const getTelegramBotInfo = async (
  botToken: string
) => {
  const response = await axios.get(
    `https://api.telegram.org/bot${botToken}/getMe`
  );

  return response.data;
};