-- AlterEnum
BEGIN;
CREATE TYPE "IntegrationStatus_new" AS ENUM ('PENDING_SELECTION', 'CONNECTED', 'EXPIRED');
ALTER TABLE "public"."integration" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "integration" ALTER COLUMN "status" TYPE "IntegrationStatus_new" USING ("status"::text::"IntegrationStatus_new");
ALTER TYPE "IntegrationStatus" RENAME TO "IntegrationStatus_old";
ALTER TYPE "IntegrationStatus_new" RENAME TO "IntegrationStatus";
DROP TYPE "public"."IntegrationStatus_old";
ALTER TABLE "integration" ALTER COLUMN "status" SET DEFAULT 'PENDING_SELECTION';
COMMIT;

-- DropIndex
DROP INDEX "integration_siteId_provider_externalId_key";

-- AlterTable
ALTER TABLE "integration" DROP COLUMN "externalId",
DROP COLUMN "externalLabel",
DROP COLUMN "provider",
DROP COLUMN "refreshToken",
ADD COLUMN     "adAccountId" TEXT,
ADD COLUMN     "adAccountName" TEXT;

-- DropEnum
DROP TYPE "IntegrationProvider";

-- CreateIndex
CREATE UNIQUE INDEX "integration_siteId_adAccountId_key" ON "integration"("siteId", "adAccountId");

