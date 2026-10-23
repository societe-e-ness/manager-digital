-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('GOOGLE_BUSINESS', 'META_ADS');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('PENDING_SELECTION', 'CONNECTED', 'EXPIRED', 'ERROR');

-- CreateTable
CREATE TABLE "integration" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'PENDING_SELECTION',
    "externalId" TEXT,
    "externalLabel" TEXT,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "expiresAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "integration_status_expiresAt_idx" ON "integration"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "integration_siteId_provider_externalId_key" ON "integration"("siteId", "provider", "externalId");
