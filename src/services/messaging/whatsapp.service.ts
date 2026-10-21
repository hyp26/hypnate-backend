import axios from "axios";
import prisma from "../../prisma/client";
import { decrypt } from "../crypto.service";
import { ENV } from "../../config/env";
import { logger } from "../../utils/logger";
import { AppError } from "../../utils/AppError";
import {
  assertOwnedPhoneNumberForSend,
  PhoneOwnershipError,
} from "../whatsappOwnership.service";

const GRAPH_VERSION =
  ENV.META_GRAPH_VERSION || "v25.0";

const GRAPH_URL =
  `https://graph.facebook.com/${GRAPH_VERSION}`;

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
        metaErrorType: axiosError.response?.data?.error?.type ?? null,
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
        metaErrorType: axiosError.response?.data?.error?.type ?? null,
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
        metaErrorType: axiosError.response?.data?.error?.type ?? null,
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
        metaErrorType: axiosError.response?.data?.error?.type ?? null,
        metaErrorMessage:
          axiosError.response?.data?.error?.message ?? null,
      }
    );
  }
};

/*
 * Discover the WhatsApp Business Accounts granted to an
 * OAuth access token.
 *
 * The WhatsApp login dialog issues an asset-scoped token: the
 * granted WABA appears in the token's granular scopes
 * (whatsapp_business_management.target_ids). Business
 * management endpoints such as
 * /{business-id}/owned_whatsapp_business_accounts are NOT
 * usable with these tokens, so this is the discovery path for
 * the OAuth callback.
 *
 * Returns every granted WABA ID, deduplicated, preserving
 * Meta's ordering. Throws AppError when no WABA was granted
 * to the token so the OAuth callback can follow its existing
 * failure path.
 */
export const getGrantedWabaIdsFromToken = async (
  accessToken: string
): Promise<string[]> => {
  /*
   * /debug_token is authorized with the app access token
   * built from the existing META_APP_ID and META_APP_SECRET.
   * Neither credential, nor the inspected token, is ever
   * logged.
   */
  const appAccessToken =
    `${ENV.META_APP_ID}|${ENV.META_APP_SECRET}`;

  try {
    const { data } = await axios.get(
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

    const tokenData =
      (data?.data ?? {}) as MetaDebugTokenData;

    const granularScopes = Array.isArray(
      tokenData.granular_scopes
    )
      ? tokenData.granular_scopes
      : [];

    const whatsappManagementEntry = granularScopes.find(
      (entry: MetaGranularScope) =>
        entry?.scope ===
        "whatsapp_business_management"
    );

    const targetIds = Array.isArray(
      whatsappManagementEntry?.target_ids
    )
      ? whatsappManagementEntry.target_ids
      : [];

    /*
     * Keep only non-empty string IDs, deduplicated, in
     * Meta's original order.
     */
    const grantedWabaIds: string[] = [];

    targetIds.forEach((targetId: unknown) => {
      if (
        typeof targetId === "string" &&
        targetId.length > 0 &&
        !grantedWabaIds.includes(targetId)
      ) {
        grantedWabaIds.push(targetId);
      }
    });

    logger.info("WhatsApp WABA discovery", {
      graphVersion: GRAPH_VERSION,
      grantedWabaIds,
      grantedWabaCount: grantedWabaIds.length,
    });

    if (!grantedWabaIds.length) {
      throw new AppError(
        "No WhatsApp Business Account was granted to this OAuth token",
        400
      );
    }

    return grantedWabaIds;
  } catch (err) {
    if (err instanceof AppError) {
      throw err;
    }

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
        graphVersion: GRAPH_VERSION,
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

/*
 * LOW-LEVEL send primitive: submits a message to Meta with a
 * raw access token and phone-number ID.
 *
 * SECURITY: callers MUST verify, via
 * assertOwnedPhoneNumberForSend() (or the administrative
 * transfer workflow), that the phone-number ID is actively
 * owned by the seller whose credential is used — never call
 * this directly with an unverified phone-number ID from
 * connection metadata. sendWhatsAppMessageForSeller() is the
 * guarded entry point.
 */
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

/*
 * Pure phone-number selection for outbound sends
 * (audit finding H-3). The normalized ownership mapping is
 * the ONLY candidate source — connection metadata is never
 * used as a fallback. The selection is then validated against
 * the ownership mapping by the caller.
 *
 *   - an explicitly requested number is always used as given
 *     (and then ownership-validated);
 *   - with no explicit request, exactly ONE active owned
 *     number resolves unambiguously;
 *   - multiple owned numbers are AMBIGUOUS — an arbitrary
 *     first number is never selected;
 *   - no owned numbers → NONE (fail closed).
 */
export type OutboundPhoneNumberSelection =
  | { kind: "selected"; phoneNumberId: string }
  | { kind: "ambiguous"; phoneNumberIds: string[] }
  | { kind: "none" };

export const selectOutboundPhoneNumberId = (
  requestedPhoneNumberId: string | undefined,
  ownedPhoneNumberIds: string[]
): OutboundPhoneNumberSelection => {
  const requested = requestedPhoneNumberId?.trim();

  if (requested) {
    return { kind: "selected", phoneNumberId: requested };
  }

  const unique = [
    ...new Set(
      ownedPhoneNumberIds
        .map((id) => (typeof id === "string" ? id.trim() : ""))
        .filter(Boolean)
    ),
  ];

  if (unique.length === 1) {
    return { kind: "selected", phoneNumberId: unique[0] };
  }

  if (unique.length > 1) {
    return { kind: "ambiguous", phoneNumberIds: unique };
  }

  return { kind: "none" };
};

/*
 * Outbound WhatsApp send with ownership enforcement
 * (audit finding H-3).
 *
 * Before any message is submitted to Meta:
 *   1. the seller's active WhatsApp connection is loaded
 *      (its credential is the only one that may be used);
 *   2. the phone-number ID is chosen from the connection's
 *      ACTIVE ownership rows only — never from connection
 *      metadata — and must be unambiguous unless the caller
 *      explicitly requested a specific number;
 *   3. ownership is re-verified UNDER the same per-phone
 *      advisory lock used by webhooks, transfers, and OAuth
 *      sync (assertOwnedPhoneNumberForSend): the active owner
 *      must be exactly this seller AND exactly this
 *      connection, otherwise the send is rejected with a safe
 *      403 BEFORE the Meta API is called.
 *
 * DOCUMENTED RESIDUAL RACE (not claimed to be eliminated):
 * the verification transaction COMMITS before the Meta HTTP
 * request. An administrative transfer that acquires the phone
 * lock after this commit but before Meta accepts the request
 * can flip ownership mid-send. Closing this window strictly
 * would require holding the advisory lock (and an open
 * database transaction) across the unbounded Meta network
 * call, which this design deliberately avoids for
 * operational safety. The consequence is bounded to a single
 * already-authorized message submitted via the number's own
 * phone-number ID; inbound routing and every later send
 * resolve to the new owner. If stricter ordering is ever
 * required, a send reservation / coordinated lock held across
 * the HTTP call with an explicit timeout is the follow-up
 * design.
 */
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
        id: true,
        accessToken: true,
      },
    });

  if (
    !connection ||
    !connection.accessToken
  ) {
    throw new AppError(
      "WhatsApp is not connected for this seller",
      400
    );
  }

  /*
   * Candidate phone numbers come from the ACTIVE ownership
   * rows of this connection — the authoritative mapping —
   * never from connection metadata.
   */
  const ownedRows =
    await prisma.whatsAppPhoneOwnership.findMany({
      where: {
        connectionId: connection.id,
        isActive: true,
      },
      select: {
        phoneNumberId: true,
      },
      orderBy: {
        phoneNumberId: "asc",
      },
    });

  const selection = selectOutboundPhoneNumberId(
    phoneNumberId,
    ownedRows.map((row) => row.phoneNumberId)
  );

  if (selection.kind === "ambiguous") {
    throw new AppError(
      "Multiple WhatsApp phone numbers are owned by this connection; specify which phone-number ID to use",
      400
    );
  }

  if (selection.kind === "none") {
    throw new AppError(
      "No active WhatsApp phone-number ownership exists for this connection. Please reconnect WhatsApp.",
      400
    );
  }

  const resolvedPhoneNumberId = selection.phoneNumberId;

  /*
   * Ownership verification under the per-phone advisory lock.
   * Rejected BEFORE any Meta API call — unknown, ambiguous,
   * inactive, or foreign-owned numbers never reach Meta.
   */
  try {
    await prisma.$transaction(async (tx) => {
      await assertOwnedPhoneNumberForSend(tx, {
        sellerId,
        connectionId: connection.id,
        phoneNumberId: resolvedPhoneNumberId,
      });
    });
  } catch (err) {
    if (err instanceof PhoneOwnershipError) {
      throw new AppError(
        "This WhatsApp phone number is not owned by the requesting seller's connection",
        403
      );
    }

    throw err;
  }

  let accessToken: string;

  try {
    accessToken = decrypt(
      connection.accessToken
    );
  } catch {
    throw new AppError(
      "WhatsApp access token could not be decrypted",
      500
    );
  }

  return sendWhatsAppMessage(
    accessToken,
    resolvedPhoneNumberId,
    to,
    text
  );
};

/*
 * LOW-LEVEL template send primitive: submits a WhatsApp
 * template with a raw access token and phone-number ID.
 *
 * SECURITY: no in-repo caller currently exists. Any future
 * caller MUST first verify ownership of the phone-number ID
 * via assertOwnedPhoneNumberForSend() for the seller whose
 * credential is used — the phone-number ID must never be
 * taken from unverified connection metadata.
 */
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
