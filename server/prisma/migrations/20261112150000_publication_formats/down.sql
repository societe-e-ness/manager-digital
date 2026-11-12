-- Retour arrière de 20261112150000_publication_formats : retire le format et les images, remet le
-- nombre d'images (à 0 : les images n'étaient pas conservées avant ce ticket).
--   npx prisma db execute --file prisma/migrations/20261112150000_publication_formats/down.sql
--   puis supprimer la ligne de cette migration dans _prisma_migrations.
ALTER TABLE "publication" DROP COLUMN "format",
DROP COLUMN "images",
ADD COLUMN     "image_count" INTEGER NOT NULL DEFAULT 0;
