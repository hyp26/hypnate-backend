
import { Prisma } from "@prisma/client";

/**
 * Acquires a transaction-scoped row lock for a conversation.
 *
 * The caller must already hold the WhatsApp phone-number advisory
 * lock when the conversation belongs to WhatsApp.
 *
 * The lock is released automatically when the transaction commits
 * or rolls back.
 */
export const acquireConversationRowLock = async (
  tx: Prisma.TransactionClient,
  conversationId: number
): Promise<boolean> => {
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return false;
  }

  const rows = await tx.$queryRaw<Array<{ id: number }>>`
    SELECT "id"
    FROM "Conversation"
    WHERE "id" = ${conversationId}
    FOR UPDATE
  `;

  return rows.length === 1;
};
