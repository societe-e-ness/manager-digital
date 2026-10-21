-- Retour arrière de 20261021200000_publication : supprime l'historique des Publications diffusées.
--   npx prisma db execute --file prisma/migrations/20261021200000_publication/down.sql
--   puis supprimer la ligne de cette migration dans _prisma_migrations.
-- DropForeignKey
ALTER TABLE "publication" DROP CONSTRAINT "publication_site_id_fkey";

-- DropForeignKey
ALTER TABLE "publication" DROP CONSTRAINT "publication_resource_id_fkey";

-- DropForeignKey
ALTER TABLE "publication" DROP CONSTRAINT "publication_author_id_fkey";

-- DropTable
DROP TABLE "publication";

-- DropEnum
DROP TYPE "publication_status";

