/*
  Warnings:

  - You are about to drop the column `externalId` on the `Conversation` table. All the data in the column will be lost.
  - You are about to drop the column `tgBotToken` on the `Seller` table. All the data in the column will be lost.
  - You are about to drop the column `waApiKey` on the `Seller` table. All the data in the column will be lost.
  - You are about to drop the column `waPhone` on the `Seller` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[sellerId,platform,externalUserId]` on the table `Conversation` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `externalUserId` to the `Conversation` table without a default value. This is not possible if the table is not empty.
  - Added the required column `direction` to the `Message` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('SENT', 'DELIVERED', 'READ', 'FAILED');

-- DropIndex
DROP INDEX "Conversation_sellerId_platform_idx";

-- DropIndex
DROP INDEX "Store_slug_idx";

-- AlterTable
ALTER TABLE "Conversation" DROP COLUMN "externalId",
ADD COLUMN     "externalThreadId" TEXT,
ADD COLUMN     "externalUserId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "direction" "MessageDirection" NOT NULL,
ADD COLUMN     "status" "MessageStatus" NOT NULL DEFAULT 'SENT';

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "priority" TEXT;

-- AlterTable
ALTER TABLE "Seller" DROP COLUMN "tgBotToken",
DROP COLUMN "waApiKey",
DROP COLUMN "waPhone";

-- CreateTable
CREATE TABLE "ChannelConnection" (
    "id" SERIAL NOT NULL,
    "sellerId" INTEGER NOT NULL,
    "platform" "Platform" NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "externalAccountId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChannelConnection_sellerId_idx" ON "ChannelConnection"("sellerId");

-- CreateIndex
CREATE INDEX "ChannelConnection_platform_idx" ON "ChannelConnection"("platform");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_sellerId_platform_externalUserId_key" ON "Conversation"("sellerId", "platform", "externalUserId");

-- AddForeignKey
ALTER TABLE "ChannelConnection" ADD CONSTRAINT "ChannelConnection_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
