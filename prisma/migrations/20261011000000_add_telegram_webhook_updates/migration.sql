-- Durable idempotency ledger for Telegram webhook deliveries, keyed by
-- Telegram's update_id per seller. The unique index makes duplicate claims
-- collide safely under concurrent webhook requests. Safe to re-run.

CREATE TABLE IF NOT EXISTS "TelegramWebhookUpdate" (
    "id" SERIAL NOT NULL,
    "sellerId" INTEGER NOT NULL,
    "updateId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROCESSING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramWebhookUpdate_pkey" PRIMARY KEY ("id")
);

-- Prevents duplicate processing of the same Telegram update for a seller.
CREATE UNIQUE INDEX IF NOT EXISTS "TelegramWebhookUpdate_sellerId_updateId_key"
    ON "TelegramWebhookUpdate"("sellerId", "updateId");

-- Supports locating stuck PROCESSING rows for operational recovery.
CREATE INDEX IF NOT EXISTS "TelegramWebhookUpdate_status_createdAt_idx"
    ON "TelegramWebhookUpdate"("status", "createdAt");
