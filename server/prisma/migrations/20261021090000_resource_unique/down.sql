-- Retour arrière de 20261021090000_resource_unique, sur une base VIDE uniquement.
-- S'il reste des liens, il échoue (colonnes NOT NULL sans valeur) au lieu de perdre des données.
--   npx prisma db execute --file prisma/migrations/20261021090000_resource_unique/down.sql
--   puis supprimer la ligne de cette migration dans _prisma_migrations.

-- DropForeignKey
ALTER TABLE "resource" DROP CONSTRAINT "resource_site_id_fkey";

-- DropForeignKey
ALTER TABLE "resource" DROP CONSTRAINT "resource_parent_id_fkey";

-- DropForeignKey
ALTER TABLE "integration_resource" DROP CONSTRAINT "integration_resource_resource_id_fkey";

-- DropIndex
DROP INDEX "integration_resource_resource_id_idx";

-- AlterTable
ALTER TABLE "integration_resource" DROP CONSTRAINT "integration_resource_pkey",
DROP COLUMN "resource_id",
ADD COLUMN     "external_id" TEXT NOT NULL,
ADD COLUMN     "id" SERIAL NOT NULL,
ADD COLUMN     "last_error" TEXT,
ADD COLUMN     "last_synced_at" TIMESTAMP(3),
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "name" TEXT NOT NULL,
ADD COLUMN     "parent_id" INTEGER,
ADD COLUMN     "site_id" INTEGER,
ADD COLUMN     "type" "resource_type" NOT NULL,
ADD CONSTRAINT "integration_resource_pkey" PRIMARY KEY ("id");

-- DropTable
DROP TABLE "resource";

-- CreateIndex
CREATE UNIQUE INDEX "integration_resource_integration_id_type_external_id_key" ON "integration_resource"("integration_id", "type", "external_id");

-- AddForeignKey
ALTER TABLE "integration_resource" ADD CONSTRAINT "integration_resource_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_resource" ADD CONSTRAINT "integration_resource_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "integration_resource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

