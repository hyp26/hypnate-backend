import { logger } from "../utils/logger";

/*
 * Tenant-safe conversation-room emission.
 *
 * Authorization model: a socket may receive events for a
 * conversation ONLY if socket.data.sellerId matches the
 * conversation's CURRENT owner (conversation.sellerId at emit
 * time). Stale room membership — for example an old seller's
 * socket still joined to room_<id> after an ownership transfer —
 * is filtered out at emission, so joining a room once can never
 * grant durable cross-tenant access.
 *
 * This is enforced at EMIT time rather than relying solely on
 * transfer-time eviction because eviction is best-effort: with
 * the default (in-memory) Socket.IO adapter, fetchSockets()
 * only reaches sockets connected to THIS process. The
 * Hypnate backend currently runs a single instance, so
 * eviction + emit-time authorization together close the gap.
 * Multi-instance deployments additionally require the Redis
 * adapter (or equivalent) for eviction to be complete —
 * emit-time authorization remains correct regardless because
 * each instance evaluates it for its own sockets.
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
  };
};

const asIo = (io: unknown): IoLike | null => {
  if (!io || typeof io !== "object") {
    return null;
  }

  const candidate = io as Partial<IoLike>;

  if (
    typeof candidate.in !== "function" ||
    typeof candidate.in("room_0") !== "object" ||
    candidate.in("room_0") === null
  ) {
    return null;
  }

  return candidate as IoLike;
};

/*
 * Emit an event to every socket currently in the conversation
 * room that belongs to the conversation's CURRENT owner seller.
 * Sockets with a different or missing sellerId are skipped.
 * Returns the number of sockets that actually received the
 * event. Never throws — emission is best-effort delivery.
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
