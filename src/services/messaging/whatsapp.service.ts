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

type MetaPermissionEntry = {
  permission?: string;
  status?: string;
};

type MetaGranularScope = {
  scope?: string;
  target_ids?: unknown;
};

type MetaDebugTokenData = {
  is_valid?: boolean;
  app_id?: string | number;
  user_id?: string | number;
  scopes?: unknown;
  granular_scopes?: unknown;
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

export const diagnoseKnownWabaAccess = async (
  accessToken: string
): Promise<void> => {
  const wabaId = "1342892884093874";

  try {
    const response = await axios.get(
      `${GRAPH_URL}/${wabaId}`,
      {
        params: {
          fields: "id,name,business_id",
        },
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    logger.info("WhatsApp known WABA access diagnostic", {
      wabaId,
      graphVersion: GRAPH_VERSION,
      httpStatus: response.status,
      requestSucceeded: true,
      returnedWabaId: response.data?.id ?? null,
      returnedWabaName: response.data?.name ?? null,
      returnedWabaBusinessId: response.data?.business_id ?? null,
    });
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
      "WhatsApp known WABA access diagnostic failed",
      undefined,
      {
        wabaId,
        graphVersion: GRAPH_VERSION,
        httpStatus: axiosError.response?.status ?? null,
        metaErrorCode:
          axiosError.response?.data?.error?.code ?? null,
        metaErrorType:
          axiosError.response?.data?.error?.type ?? null,
        metaErrorMessage:
          axiosError.response?.data?.error?.message ?? null,
      }
    );
  }
};

export const diagnoseOAuthTokenIdentity = async (
  accessToken: string
): Promise<void> => {
  try {
    const response = await axios.get(
      `${GRAPH_URL}/me`,
      {
        params: {
          fields: "id,name",
        },
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    logger.info("WhatsApp OAuth token identity diagnostic", {
      graphVersion: GRAPH_VERSION,
      httpStatus: response.status,
      requestSucceeded: true,
      userId: response.data?.id ?? null,
      userName: response.data?.name ?? null,
    });
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
      "WhatsApp OAuth token identity diagnostic failed",
      undefined,
      {
        graphVersion: GRAPH_VERSION,
        httpStatus: axiosError.response?.status ?? null,
        metaErrorCode:
          axiosError.response?.data?.error?.code ?? null,
        metaErrorType:
          axiosError.response?.data?.error?.type ?? null,
        metaErrorMessage:
          axiosError.response?.data?.error?.message ?? null,
      }
    );
  }

  try {
    const response = await axios.get(
      `${GRAPH_URL}/me/permissions`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    logger.info("WhatsApp OAuth token permissions diagnostic", {
      graphVersion: GRAPH_VERSION,
      httpStatus: response.status,
      requestSucceeded: true,
      permissions: Array.isArray(response.data?.data)
        ? response.data.data.map(
            (permission: MetaPermissionEntry) => ({
              permission: permission?.permission ?? null,
              status: permission?.status ?? null,
            })
          )
        : [],
    });
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
      "WhatsApp OAuth token permissions diagnostic failed",
      undefined,
      {
        graphVersion: GRAPH_VERSION,
        httpStatus: axiosError.response?.status ?? null,
        metaErrorCode:
          axiosError.response?.data?.error?.code ?? null,
        metaErrorType:
          axiosError.response?.data?.error?.type ?? null,
        metaErrorMessage:
          axiosError.response?.data?.error?.message ?? null,
      }
    );
  }
};

export const diagnoseOAuthTokenScopes = async (
  accessToken: string
): Promise<void> => {
  try {
    /*
     * TEMPORARY DIAGNOSTIC ONLY (token granular scopes).
     *
     * /debug_token is authorized with the app access token built
     * from the existing META_APP_ID and META_APP_SECRET. Neither
     * credential, nor the inspected token, is ever logged.
     */
    const appAccessToken =
      `${ENV.META_APP_ID}|${ENV.META_APP_SECRET}`;

    const response = await axios.get(
      `${GRAPH_URL}/debug_token`,
      {
        params: {
          input_token: accessToken,
        },
        headers: {
          Authorization: `Bearer ${appAccessToken}`,
        },
      }
    );

    const data =
      (response.data?.data ?? {}) as MetaDebugTokenData;

    const scopes = Array.isArray(data.scopes)
      ? data.scopes.map(
          (scope: unknown) => String(scope)
        )
      : [];

    const granularScopes = Array.isArray(
      data.granular_scopes
    )
      ? data.granular_scopes.map(
          (entry: MetaGranularScope) => ({
            scope:
              typeof entry?.scope === "string"
                ? entry.scope
                : null,
            targetIds: Array.isArray(entry?.target_ids)
              ? entry.target_ids.map(
                  (targetId: unknown) => String(targetId)
                )
              : [],
          })
        )
      : [];

    const knownWabaId = "1342892884093874";

    const whatsappManagementEntry = granularScopes.find(
      (entry) =>
        entry.scope === "whatsapp_business_management"
    );

    const knownWabaGranted =
      !!whatsappManagementEntry &&
      whatsappManagementEntry.targetIds.includes(knownWabaId);

    logger.info("WhatsApp OAuth token scopes diagnostic", {
      graphVersion: GRAPH_VERSION,
      httpStatus: response.status,
      requestSucceeded: true,
      isValid: data.is_valid ?? null,
      appId:
        data.app_id !== undefined
          ? String(data.app_id)
          : null,
      userId:
        data.user_id !== undefined
          ? String(data.user_id)
          : null,
      scopes,
      granularScopes,
      granularScopesPresent: Array.isArray(
        data.granular_scopes
      ),
      whatsappBusinessManagementTargetIds:
        whatsappManagementEntry?.targetIds ?? [],
      knownWabaGranted,
      /*
       * Safe response-shape hints in case Meta returns a
       * different structure: top-level field names and value
       * types only. Never values.
       */
      shapeDataKeys: Object.keys(data),
      shapeGranularScopesType: Array.isArray(
        data.granular_scopes
      )
        ? "array"
        : typeof data.granular_scopes,
      shapeScopesType: Array.isArray(data.scopes)
        ? "array"
        : typeof data.scopes,
    });
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
      "WhatsApp OAuth token scopes diagnostic failed",
      undefined,
      {
        graphVersion: GRAPH_VERSION,
        httpStatus: axiosError.response?.status ?? null,
        metaErrorCode:
          axiosError.response?.data?.error?.code ?? null,
        metaErrorType:
          axiosError.response?.data?.error?.type ?? null,
        metaErrorMessage:
          axiosError.response?.data?.error?.message ?? null,
      }
    );
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
