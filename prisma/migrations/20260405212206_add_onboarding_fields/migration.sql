-- AlterTable
ALTER TABLE "Seller" ADD COLUMN     "businessSize" TEXT,
ADD COLUMN     "gatewayKeyId" TEXT,
ADD COLUMN     "gatewayKeySecret" TEXT,
ADD COLUMN     "industry" TEXT,
ADD COLUMN     "onboardedAt" TIMESTAMP(3),
ADD COLUMN     "paymentGateway" TEXT,
ADD COLUMN     "tgBotToken" TEXT,
ADD COLUMN     "waApiKey" TEXT,
ADD COLUMN     "waPhone" TEXT;
