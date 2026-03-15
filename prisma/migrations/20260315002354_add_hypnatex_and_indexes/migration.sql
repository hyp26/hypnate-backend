-- CreateEnum
CREATE TYPE "BuildStatus" AS ENUM ('QUEUED', 'GENERATING_PAGES', 'UPLOADING_PRODUCTS', 'APPLYING_THEME', 'DEPLOYING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "StoreStatus" AS ENUM ('BUILDING', 'LIVE', 'PAUSED');

-- CreateTable
CREATE TABLE "Theme" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "previewBg" TEXT NOT NULL,
    "accentColor" TEXT NOT NULL,
    "layout" TEXT NOT NULL,
    "tags" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Theme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Store" (
    "id" SERIAL NOT NULL,
    "sellerId" INTEGER NOT NULL,
    "themeId" TEXT NOT NULL,
    "storeName" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logoUrl" TEXT,
    "customDomain" TEXT,
    "status" "StoreStatus" NOT NULL DEFAULT 'BUILDING',
    "publishedAt" TIMESTAMP(3),
    "homepageHtml" TEXT,
    "aboutHtml" TEXT,
    "metaTitle" TEXT,
    "metaDesc" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Store_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuildJob" (
    "id" SERIAL NOT NULL,
    "storeId" INTEGER NOT NULL,
    "sellerId" INTEGER NOT NULL,
    "status" "BuildStatus" NOT NULL DEFAULT 'QUEUED',
    "currentStep" TEXT,
    "errorMsg" TEXT,
    "themeId" TEXT NOT NULL,
    "storeName" TEXT NOT NULL,
    "logoUrl" TEXT,
    "catalogJson" JSONB,
    "deployedUrl" TEXT,
    "buildLog" JSONB,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuildJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Store_slug_key" ON "Store"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Store_customDomain_key" ON "Store"("customDomain");

-- CreateIndex
CREATE INDEX "Store_sellerId_idx" ON "Store"("sellerId");

-- CreateIndex
CREATE INDEX "Store_slug_idx" ON "Store"("slug");

-- CreateIndex
CREATE INDEX "BuildJob_storeId_idx" ON "BuildJob"("storeId");

-- CreateIndex
CREATE INDEX "BuildJob_sellerId_idx" ON "BuildJob"("sellerId");

-- CreateIndex
CREATE INDEX "BuildJob_status_idx" ON "BuildJob"("status");

-- CreateIndex
CREATE INDEX "Order_sellerId_idx" ON "Order"("sellerId");

-- CreateIndex
CREATE INDEX "Order_customerId_idx" ON "Order"("customerId");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");

-- CreateIndex
CREATE INDEX "Product_sellerId_idx" ON "Product"("sellerId");

-- AddForeignKey
ALTER TABLE "Store" ADD CONSTRAINT "Store_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Store" ADD CONSTRAINT "Store_themeId_fkey" FOREIGN KEY ("themeId") REFERENCES "Theme"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildJob" ADD CONSTRAINT "BuildJob_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
