/*
  Warnings:

  - You are about to drop the column `mediaUrl` on the `Message` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[sellerId,platform]` on the table `ChannelConnection` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[sellerId,platform,externalUserId,externalThreadId]` on the table `Conversation` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `updatedAt` to the `ChannelConnection` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "Conversation_sellerId_platform_externalUserId_key";

-- AlterTable
ALTER TABLE "ChannelConnection" ADD COLUMN     "name" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "webhookSecret" TEXT,
ADD COLUMN     "webhookUrl" TEXT;

-- AlterTable
ALTER TABLE "Message" DROP COLUMN "mediaUrl",
ADD COLUMN     "externalMessageId" TEXT,
ADD COLUMN     "replyToMessageId" INTEGER;

-- CreateTable
CREATE TABLE "QuickReply" (
    "id" SERIAL NOT NULL,
    "sellerId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuickReply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" SERIAL NOT NULL,
    "platform" "Platform" NOT NULL,
    "sellerId" INTEGER,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuickReply_sellerId_idx" ON "QuickReply"("sellerId");

-- CreateIndex
CREATE INDEX "WebhookEvent_platform_idx" ON "WebhookEvent"("platform");

-- CreateIndex
CREATE INDEX "WebhookEvent_processed_idx" ON "WebhookEvent"("processed");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelConnection_sellerId_platform_key" ON "ChannelConnection"("sellerId", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_sellerId_platform_externalUserId_externalThrea_key" ON "Conversation"("sellerId", "platform", "externalUserId", "externalThreadId");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_replyToMessageId_fkey" FOREIGN KEY ("replyToMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickReply" ADD CONSTRAINT "QuickReply_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
