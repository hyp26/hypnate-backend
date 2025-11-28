-- CreateTable
CREATE TABLE "Upload" (
    "id" SERIAL NOT NULL,
    "sellerId" INTEGER NOT NULL,
    "filename" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Upload_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Upload" ADD CONSTRAINT "Upload_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
