-- Explicit cross-seller conversation access.
-- Original conversation ownership remains unchanged.

CREATE TABLE "ConversationShare" (
    "id" SERIAL NOT NULL,
    "conversationId" INTEGER NOT NULL,
    "ownerSellerId" INTEGER NOT NULL,
    "sharedWithSellerId" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationShare_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Conversation_id_sellerId_key"
    ON "Conversation"("id", "sellerId");

CREATE INDEX "ConversationShare_ownerSellerId_isActive_idx"
    ON "ConversationShare"("ownerSellerId", "isActive");

CREATE INDEX "ConversationShare_sharedWithSellerId_isActive_idx"
    ON "ConversationShare"("sharedWithSellerId", "isActive");

CREATE UNIQUE INDEX "ConversationShare_conversationId_sharedWithSellerId_key"
    ON "ConversationShare"("conversationId", "sharedWithSellerId");

ALTER TABLE "ConversationShare"
    ADD CONSTRAINT "ConversationShare_conversationId_ownerSellerId_fkey"
    FOREIGN KEY ("conversationId", "ownerSellerId")
    REFERENCES "Conversation"("id", "sellerId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ConversationShare"
    ADD CONSTRAINT "ConversationShare_ownerSellerId_fkey"
    FOREIGN KEY ("ownerSellerId")
    REFERENCES "Seller"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ConversationShare"
    ADD CONSTRAINT "ConversationShare_sharedWithSellerId_fkey"
    FOREIGN KEY ("sharedWithSellerId")
    REFERENCES "Seller"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;