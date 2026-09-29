import axios from "axios";
import prisma from "../../prisma/client";
import { decrypt } from "../crypto.service";
import { ENV } from "../../config/env";
import { logger } from "../../utils/logger";

const GRAPH_VERSION =
  ENV.META_GRAPH_VERSION || "v25.0";

const GRAPH_URL =
  `https://graph.facebook.com/${GRAPH_VERSION}`;

type WhatsAppPhoneNumber = {
  id?: string;
  phone_number_id?: string;
};

type WhatsAppMetadata = {
  phoneNumberId?: string;
  primaryPhoneNumberId?: string;
  phoneNumberIds?: unknown;
  phoneNumbers?: unknown;
};

export const exchangeCodeForAccessToken = async (
  code: string
) => {
  const { data } = await axios.get(
    `${GRAPH_URL}/oauth/access_token`,
    {
      params: {
        client_id: ENV.META_APP_ID,
        client_secret: ENV.META_APP_SECRET,
        redirect_uri: ENV.META_REDIRECT_URI,
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
  try {
    const { data } = await axios.get(
      `${GRAPH_URL}/${businessId}/owned_whatsapp_business_accounts`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    logger.info("WhatsApp WABA discovery", {
      businessId,
      graphVersion: GRAPH_VERSION,
      isArray: Array.isArray(data?.data),
      count: Array.isArray(data?.data) ? data.data.length : 0,
      wabas: Array.isArray(data?.data)
        ? data.data.map(
            (waba: { id?: string; name?: string }) => ({
              id: waba?.id,
              name: waba?.name,
            })
          )
        : [],
    });

    return data.data;
  } catch (err) {
    const axiosError = err as {
      response?: {
        status?: number;
        data?: {
          error?: {
            code?: number;
            type?: string;
            message?: string;
          };
        };
      };
    };

    logger.error(
      "WhatsApp WABA discovery failed",
      undefined,
      {
        businessId,
        httpStatus: axiosError.response?.status ?? null,
        metaErrorCode: axiosError.response?.data?.error?.code ?? null,
        metaErrorType: axiosError.response?.data?.error?.type ?? null,
        metaErrorMessage:
          axiosError.response?.data?.error?.message ?? null,
      }
    );

    throw err;
  }
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

/*
 * Fetch a single WhatsApp Business Account.
 *
 * Used to validate that the stored access token still
 * works and that the account is still reachable.
 */
export const getWhatsAppBusinessAccount = async (
  accessToken: string,
  wabaId: string
) => {
  const { data } = await axios.get(
    `${GRAPH_URL}/${wabaId}`,
    {
      params: {
        fields: "id,name,account_review_status",
      },
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  return data;
};

/*
 * Subscribe this app to the WABA's webhook events.
 *
 * Meta requires POST /{waba-id}/subscribed_apps before
 * messages and message status events for the phone numbers
 * under this WABA are delivered to the app webhook.
 */
export const subscribeWabaWebhooks = async (
  accessToken: string,
  wabaId: string
): Promise<boolean> => {
  const { data } = await axios.post(
    `${GRAPH_URL}/${wabaId}/subscribed_apps`,
    {},
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  return data?.success === true;
};

/*
 * Unsubscribe this app from the WABA's webhook events.
 *
 * Used when a seller disconnects their WhatsApp channel so
 * no further webhook events are delivered for their number.
 */
export const unsubscribeWabaWebhooks = async (
  accessToken: string,
  wabaId: string
): Promise<boolean> => {
  const { data } = await axios.delete(
    `${GRAPH_URL}/${wabaId}/subscribed_apps`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  return data?.success === true;
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
        "Content-Type": "application/json",
      },
    }
  );

  return data;
};

export const sendWhatsAppMessageForSeller = async (
  sellerId: number,
  to: string,
  text: string,
  phoneNumberId?: string
) => {
  const connection =
    await prisma.channelConnection.findFirst({
      where: {
        sellerId,
        platform: "WHATSAPP",
        isActive: true,
      },
      select: {
        accessToken: true,
        metadata: true,
      },
    });

  if (
    !connection ||
    !connection.accessToken
  ) {
    throw new Error(
      "WhatsApp is not connected for this seller"
    );
  }

  const metadata =
    (connection.metadata ?? {}) as WhatsAppMetadata;

  let resolvedPhoneNumberId =
    phoneNumberId?.trim() ||
    metadata.primaryPhoneNumberId ||
    metadata.phoneNumberId;

  if (!resolvedPhoneNumberId) {
    if (
      Array.isArray(metadata.phoneNumberIds) &&
      metadata.phoneNumberIds.length > 0
    ) {
      resolvedPhoneNumberId = String(
        metadata.phoneNumberIds[0]
      );
    }
  }

  if (!resolvedPhoneNumberId) {
    if (
      Array.isArray(metadata.phoneNumbers)
    ) {
      const first = metadata.phoneNumbers.find(
        (phone): phone is WhatsAppPhoneNumber =>
          !!phone &&
          typeof phone === "object" &&
          !!(
            (phone as WhatsAppPhoneNumber).id ??
            (phone as WhatsAppPhoneNumber)
              .phone_number_id
          )
      );

      resolvedPhoneNumberId = first
        ? String(
            first.id ??
              first.phone_number_id
          )
        : undefined;
    }
  }

  if (!resolvedPhoneNumberId) {
    throw new Error(
      "WhatsApp phone number is not configured"
    );
  }

  let accessToken: string;

  try {
    accessToken = decrypt(
      connection.accessToken
    );
  } catch {
    throw new Error(
      "WhatsApp access token could not be decrypted"
    );
  }

  return sendWhatsAppMessage(
    accessToken,
    resolvedPhoneNumberId,
    to,
    text
  );
};

export const sendWhatsAppTemplate = async (
  accessToken: string,
  phoneNumberId: string,
  to: string,
  templateName: string,
  parameters: string[]
) => {
  const { data } = await axios.post(
    `${GRAPH_URL}/${phoneNumberId}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: templateName,
        language: {
          code: "en_US",
        },
        components: [
          {
            type: "body",
            parameters: parameters.map((text) => ({
              type: "text",
              text,
            })),
          },
        ],
      },
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    }
  );

  return data;
};
