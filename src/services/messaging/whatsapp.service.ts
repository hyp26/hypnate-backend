// src/services/messaging/whatsapp.service.ts

import axios from "axios";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v23.0";
const GRAPH_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;

export const exchangeCodeForAccessToken = async (
  code: string
) => {
  const { data } = await axios.get(
    `${GRAPH_URL}/oauth/access_token`,
    {
      params: {
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        redirect_uri: process.env.META_REDIRECT_URI,
        code,
      },
    }
  );

  return data;
};

export const getBusinesses = async (
  accessToken: string
) => {
  const { data } = await axios.get(
    `${GRAPH_URL}/me/businesses`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  return data.data;
};

export const getWhatsAppBusinessAccounts = async (
  businessId: string,
  accessToken: string
) => {
  const { data } = await axios.get(
    `${GRAPH_URL}/${businessId}/owned_whatsapp_business_accounts`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  return data.data;
};

export const getPhoneNumbers = async (
  wabaId: string,
  accessToken: string
) => {
  const { data } = await axios.get(
    `${GRAPH_URL}/${wabaId}/phone_numbers`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  return data.data;
};

export const sendWhatsAppMessage = async (
  accessToken: string,
  phoneNumberId: string,
  to: string,
  text: string
) => {
  const { data } = await axios.post(
    `${GRAPH_URL}/${phoneNumberId}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: {
        body: text,
      },
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  return data;
};