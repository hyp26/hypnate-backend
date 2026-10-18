-- Dedicated journal for WhatsApp connection-ownership
-- transfers. See prisma/schema.prisma (WhatsAppTransferJournal).
--
-- Stores only identifiers, counts, connection states and
-- per-conversation before/after ownership snapshots:
-- NO access tokens, secrets, or message contents.

CREATE TABLE "WhatsAppTransferJournal" (
    "id" TEXT NOT NULL,
    "sourceSellerId" INTEGER NOT NULL,
    "destinationSellerId" INTEGER NOT NULL,
    "phoneNumberIds" JSONB NOT NULL,
    "wabaId" TEXT,
    "status" TEXT NOT NULL,
    "actorAdminId" INTEGER,
    "report" JSONB,
    "details" JSONB,
    "conversationCount" INTEGER,
    "messageCount" INTEGER,
    "connectionStates" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "WhatsAppTransferJournal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WhatsAppTransferJournal_sourceSellerId_destinationSellerId_idx"
    ON "WhatsAppTransferJournal"("sourceSellerId", "destinationSellerId");
CREATE INDEX "WhatsAppTransferJournal_createdAt_idx"
    ON "WhatsAppTransferJournal"("createdAt");
