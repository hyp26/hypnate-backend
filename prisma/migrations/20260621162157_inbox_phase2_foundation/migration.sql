-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "assignedToId" INTEGER,
ADD COLUMN     "labelId" INTEGER;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "isInternal" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Label" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Label_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Label_name_key" ON "Label"("name");

-- CreateIndex
CREATE INDEX "Conversation_assignedToId_idx" ON "Conversation"("assignedToId");

-- CreateIndex
CREATE INDEX "Conversation_labelId_idx" ON "Conversation"("labelId");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "Label"("id") ON DELETE SET NULL ON UPDATE CASCADE;
