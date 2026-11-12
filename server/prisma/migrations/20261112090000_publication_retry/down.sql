-- Retour arrière de 20261112090000_publication_retry : retire le nombre d'images et la date du dernier envoi.
--   npx prisma db execute --file prisma/migrations/20261112090000_publication_retry/down.sql
--   puis supprimer la ligne de cette migration dans _prisma_migrations.
ALTER TABLE "publication" DROP COLUMN "attempted_at",
DROP COLUMN "image_count";
