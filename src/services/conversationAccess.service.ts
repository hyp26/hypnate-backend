
import { Prisma } from "@prisma/client";
import {
  acquirePhoneNumberLock,
  resolveActiveOwner,
  PhoneOwnershipError,
} from "./whatsappOwnership.service";
import { acquireConversationRowLock } from "./conversationLock.service";

export type ConversationAccessResult = {
  conversation: Prisma.ConversationGetPayload<{}>;
  ownerSellerId: number;
  accessType: "OWNER" | "SHARED";
};

/**
 * Resolves access to one conversation.
 *
 * IMPORTANT:
 * - A share never changes conversation ownership.
 * - WhatsApp ownership is authoritative only through
 *   WhatsAppPhoneOwnership, under the shared phone lock.
 * - The conversation row lock serializes access checks with
 *   share creation and revocation.
 * - Every delegated request must have an active share.
 * - Call inside a Prisma transaction.
 */
export const resolveConversationAccess = async (
  tx: Prisma.TransactionClient,
  conversationId: number,
  requesterSellerId: number
): Promise<ConversationAccessResult | null> => {
  if (
    !Number.isInteger(conversationId) ||
    conversationId <= 0 ||
    !Number.isInteger(requesterSellerId) ||
    requesterSellerId <= 0
  ) {
    return null;
  }

  const initial = await tx.conversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      sellerId: true,
      platform: true,
      externalThreadId: true,
    },
  });

  if (!initial) {
    return null;
  }

  let phoneNumberId: string | null = null;

  if (initial.platform === "WHATSAPP") {
    phoneNumberId =
      typeof initial.externalThreadId === "string"
        ? initial.externalThreadId.trim()
        : "";

    if (!phoneNumberId) {
      return null;
    }

    // Global lock order: phone lock first, conversation row second.
    await acquirePhoneNumberLock(tx, phoneNumberId);
  }

  // Serializes authorization with share creation and revocation.
  const locked = await acquireConversationRowLock(tx, conversationId);

  if (!locked) {
    return null;
  }

  // Never authorize using the pre-lock snapshot.
  const current = await tx.conversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      sellerId: true,
      platform: true,
      externalThreadId: true,
    },
  });

  if (
    !current ||
    current.platform !== initial.platform ||
    current.externalThreadId !== initial.externalThreadId
  ) {
    return null;
  }

  if (phoneNumberId !== null) {
    let owner;

    try {
      owner = await resolveActiveOwner(tx, phoneNumberId);
    } catch (error) {
      if (error instanceof PhoneOwnershipError) {
        return null;
      }

      throw error;
    }

    // Conversation row and normalized ownership must agree.
    if (current.sellerId !== owner.sellerId) {
      return null;
    }
  }

  if (requesterSellerId === current.sellerId) {
    const conversation = await tx.conversation.findUnique({
      where: { id: conversationId },
    });

    if (!conversation) {
      return null;
    }

    return {
      conversation,
      ownerSellerId: current.sellerId,
      accessType: "OWNER",
    };
  }

  const share = await tx.conversationShare.findFirst({
    where: {
      conversationId,
      ownerSellerId: current.sellerId,
      sharedWithSellerId: requesterSellerId,
      isActive: true,
    },
    select: { id: true },
  });

  if (!share) {
    return null;
  }

  const conversation = await tx.conversation.findUnique({
    where: { id: conversationId },
  });

  if (!conversation || conversation.sellerId !== current.sellerId) {
    return null;
  }

  return {
    conversation,
    ownerSellerId: current.sellerId,
    accessType: "SHARED",
  };
};
