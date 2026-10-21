-- Retour arrière de 20261021170000_plugin_oauth : supprime les autorisations du Plugin WP.
--   npx prisma db execute --file prisma/migrations/20261021170000_plugin_oauth/down.sql
--   puis supprimer la ligne de cette migration dans _prisma_migrations.
-- DropForeignKey
ALTER TABLE "plugin_authorization_code" DROP CONSTRAINT "plugin_authorization_code_user_id_fkey";

-- DropForeignKey
ALTER TABLE "plugin_authorization_code" DROP CONSTRAINT "plugin_authorization_code_site_id_fkey";

-- DropForeignKey
ALTER TABLE "plugin_authorization" DROP CONSTRAINT "plugin_authorization_user_id_fkey";

-- DropForeignKey
ALTER TABLE "plugin_authorization" DROP CONSTRAINT "plugin_authorization_site_id_fkey";

-- DropTable
DROP TABLE "plugin_authorization_code";

-- DropTable
DROP TABLE "plugin_authorization";

