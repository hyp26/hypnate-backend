-- Add idempotency protection for inbound/outbound provider messages.
-- PostgreSQL unique indexes allow multiple NULL values, so local/internal
-- messages without an externalMessageId remain valid.
CREATE UNIQUE INDEX "Message_conversationId_externalMessageId_key"
ON "Message"("conversationId", "externalMessageId");
