import prisma from "../prisma/client";
import { logger } from "../utils/logger";
import {
  acquirePhoneNumberLock,
  PhoneOwnershipError,
  resolveActiveOwner,
} from "./whatsappOwnership.service";

/*
 * Tenant-safe conversation-room emission.
 *
 * Authorization model: a socket may receive events for a
 * conversation ONLY if socket.data.sellerId matches the
 * conversation's CURRENT owner. Stale room membership — for
 * example an old seller's socket still joined to room_<id>
 * after an ownership transfer — is filtered out at emission,
 * so joining a room once can never grant durable cross-tenant
 * access.
 *
 * SECURITY (audit finding H-1): the seller authorized to
 * receive an event must be resolved at EMISSION time, never
 * taken from a result object captured during an earlier
 * webhook transaction (a concurrent ownership transfer can
 * have committed in between). emitAuthorizedConversationEvents
 * below is the guarded entry point: it re-reads the
 * conversation, acquires the SAME per-phone-number advisory
 * lock the ownership transfer acquires, resolves the
 * authoritative owner via WhatsAppPhoneOwnership, and only
 * then emits — all inside one short database transaction, so
 * a concurrent transfer either finishes before the emission
 * (emission sees the new owner) or waits until the emission
 * has completed. No network I/O happens under the lock:
 * socket emission is in-process and bounded.
 *
 * emitToConversationRoom is retained for callers that have
 * ALREADY established the current owner under the same lock
 * protocol; do not use it with a sellerId captured earlier.
 */

export type ConversationEventName =
  | "new_message"
  | "message_status_updated"
  | "conversation_updated"
  | "conversation_access_revoked";

type SocketLike = {
  data?: { sellerId?: number };
  emit: (event: string, payload: unknown) => void;
};

type IoLike = {
  in: (room: string) => {
    fetchSockets: () => Promise<SocketLike[]>;
    emit: (event: string, payload: unknown) => void;
  };
};

const asIo = (io: unknown): IoLike | null => {
  if (!io || typeof io !== "object") {
    return null;
  }

  const candidate = io as Partial<IoLike>;

  if (typeof candidate.in !== "function") {
    return null;
  }

  const room0 = candidate.in("room_0");

  if (
    typeof room0 !== "object" ||
    room0 === null ||
    typeof room0.fetchSockets !== "function" ||
    typeof room0.emit !== "function"
  ) {
    return null;
  }

  return candidate as IoLike;
};

/*
 * Deliver an event to every socket currently in the
 * conversation room that belongs to authorizedSellerId.
 * Sockets with a different or missing sellerId are skipped.
 * Returns the number of sockets that received the event.
 * Never throws — emission is best-effort delivery.
 */
const deliverToAuthorizedSockets = async (
  socketIo: IoLike,
  conversationId: number,
  authorizedSellerId: number,
  event: ConversationEventName,
  payload: unknown
): Promise<number> => {
  let delivered = 0;

  try {
    const sockets = await socketIo
      .in(`room_${conversationId}`)
      .fetchSockets();

    for (const socket of sockets) {
      if (socket.data?.sellerId !== authorizedSellerId) {
        // Stale or foreign membership: skip, do not deliver.
        continue;
      }

      socket.emit(event, payload);

      delivered += 1;
    }
  } catch (err) {
    logger.error(
      "Authorized conversation-room emission failed",
      err
    );
  }

  return delivered;
};

/*
 * Emit an event to every socket currently in the conversation
 * room that belongs to the conversation's CURRENT owner seller.
 * Sockets with a different or missing sellerId are skipped.
 * Returns the number of sockets that actually received the
 * event. Never throws — emission is best-effort delivery.
 * DEPRECATED for new code: the authorizedSellerId must be
 * established at emission time under the phone-number lock —
 * use emitAuthorizedConversationEvents instead.
 */
export const emitToConversationRoom = async (
  io: unknown,
  conversationId: number,
  authorizedSellerId: number,
  event: ConversationEventName,
  payload: unknown
): Promise<number> => {
  const socketIo = asIo(io);

  if (!socketIo || !Number.isInteger(conversationId)) {
    return 0;
  }

  return deliverToAuthorizedSockets(
    socketIo,
    conversationId,
    authorizedSellerId,
    event,
    payload
  );
};

/*
 * One authorized emission specification.
 *
 *   - event / payload: the socket event to deliver.
 *   - toSellerRoom: also broadcast to the seller_<owner> room
 *     (the same event name and payload — payload shape
 *     compatibility is preserved).
 *   - refreshConversationInPayload: replace the payload's
 *     `conversation` field with the conversation row re-read
 *     UNDER THE LOCK, so a stale pre-transfer conversation
 *     object can never be broadcast to the new (or old) owner.
 */
export type AuthorizedConversationEvent = {
  event: ConversationEventName;
  payload: unknown;
  toSellerRoom?: boolean;
  refreshConversationInPayload?: boolean;
};

/*
 * Resolve the conversation's CURRENT owner and emit events
 * ONLY to that owner (seller room + conversation room),
 * serialized against concurrent WhatsApp ownership transfers
 * (audit finding H-1).
 *
 * Protocol (all inside ONE short prisma transaction — no
 * network I/O, no Meta API calls under the lock):
 *
 *   1. Load the conversation (id, sellerId, platform,
 *      externalThreadId). Fail closed when missing.
 *   2. WHATSAPP conversations: derive the phone-number ID from
 *      the conversation's authoritative externalThreadId,
 *      acquire the shared per-phone advisory lock, RE-READ the
 *      conversation under the lock (committed state after any
 *      competing transfer), and resolve the active owner via
 *      resolveActiveOwner (fail closed on unknown / ambiguous /
 *      inactive). The conversation's sellerId and the
 *      ownership mapping's owner MUST agree — any drift fails
 *      closed rather than guessing a seller.
 *      Non-WhatsApp platforms have no ownership-transfer
 *      mechanism, so the conversation row's own sellerId is
 *      authoritative and no phone lock is taken.
 *   3. Emit each event: seller-room broadcast (optional) plus
 *      conversation-room sockets, filtered to the resolved
 *      owner's sellerId. Stale room membership of a previous
 *      owner cannot bypass the per-socket filter.
 *
 * Returns the authorized sellerId, or null when authorization
 * failed (nothing was emitted). Never throws.
 */
export const emitAuthorizedConversationEvents = async (
  io: unknown,
  conversationId: number,
  events: AuthorizedConversationEvent[]
): Promise<number | null> => {
  const socketIo = asIo(io);

  if (
    !socketIo ||
    !Number.isInteger(conversationId) ||
    !Array.isArray(events) ||
    events.length === 0
  ) {
    return null;
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const conversation = await tx.conversation.findUnique({
        where: { id: conversationId },
        select: {
          id: true,
          sellerId: true,
          platform: true,
          externalThreadId: true,
        },
      });

      if (!conversation) {
        // Conversation vanished: fail closed, emit nothing.
        return null;
      }

      let authorizedSellerId: number;

      if (conversation.platform === "WHATSAPP") {
        const phoneNumberId =
          typeof conversation.externalThreadId === "string"
            ? conversation.externalThreadId.trim()
            : "";

        if (!phoneNumberId) {
          // Cannot derive the lock key / owner: fail closed.
          return null;
        }

        /*
         * Same lock the transfer workflow and webhook
         * processing acquire. Held until this transaction
         * commits, so a concurrent transfer either completed
         * before this read (we see the new owner below) or
         * waits until the emission has finished.
         */
        await acquirePhoneNumberLock(tx, phoneNumberId);

        /*
         * Re-read committed state AFTER acquiring the lock —
         * the pre-lock read above is never trusted for
         * authorization.
         */
        const reread = await tx.conversation.findUnique({
          where: { id: conversationId },
          select: {
            id: true,
            sellerId: true,
            platform: true,
            externalThreadId: true,
          },
        });

        if (
          !reread ||
          reread.platform !== "WHATSAPP" ||
          (typeof reread.externalThreadId === "string"
            ? reread.externalThreadId.trim()
            : "") !== phoneNumberId
        ) {
          // Thread changed under us: fail closed.
          return null;
        }

        /*
         * Authoritative, fail-closed owner resolution through
         * the normalized ownership mapping.
         */
        const owner = await resolveActiveOwner(
          tx,
          phoneNumberId
        );

        if (reread.sellerId !== owner.sellerId) {
          /*
           * Conversation row and ownership mapping disagree
           * (drift / mid-transfer state): never guess a
           * seller. Fail closed.
           */
          return null;
        }

        authorizedSellerId = owner.sellerId;
      } else {
        /*
         * No WhatsApp ownership-transfer mechanism exists for
         * other platforms: the conversation row's sellerId is
         * authoritative.
         */
        authorizedSellerId = conversation.sellerId;
      }

      /*
       * Fresh conversation row for payload refresh — read under
       * the same lock, so the broadcast can never carry a
       * pre-transfer snapshot.
       */
      const needsRefresh = events.some(
        (spec) => spec.refreshConversationInPayload
      );

      let freshConversation: Record<string, unknown> | null =
        null;

      if (needsRefresh) {
        freshConversation = await tx.conversation.findUnique({
          where: { id: conversationId },
        });

        if (!freshConversation) {
          return null;
        }
      }

      for (const spec of events) {
        let payload = spec.payload;

        if (
          spec.refreshConversationInPayload &&
          payload &&
          typeof payload === "object"
        ) {
          payload = {
            ...(payload as Record<string, unknown>),
            conversation: freshConversation,
          };
        }

        if (spec.toSellerRoom) {
          try {
            socketIo
              .in(`seller_${authorizedSellerId}`)
              .emit(spec.event, payload);
          } catch (err) {
            logger.error(
              "Authorized seller-room emission failed",
              err
            );
          }
        }

        await deliverToAuthorizedSockets(
          socketIo,
          conversationId,
          authorizedSellerId,
          spec.event,
          payload
        );
      }

      return authorizedSellerId;
    });
  } catch (err) {
    if (!(err instanceof PhoneOwnershipError)) {
      logger.error(
        "Authorized conversation emission failed",
        err
      );
    }

    // Fail closed: nothing was emitted.
    return null;
  }
};
