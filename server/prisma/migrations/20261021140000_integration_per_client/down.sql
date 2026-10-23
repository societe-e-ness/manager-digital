-- Retour arrière de 20261021140000_integration_per_client. Échoue si un même compte Meta
-- est connecté pour plusieurs Clients : supprimer d'abord les Intégrations en trop.
--   npx prisma db execute --file prisma/migrations/20261021140000_integration_per_client/down.sql
--   puis supprimer la ligne de cette migration dans _prisma_migrations.

DROP INDEX "integration_provider_external_user_id_agency_key";
DROP INDEX "integration_provider_external_user_id_client_id_key";
CREATE UNIQUE INDEX "integration_provider_external_user_id_key" ON "integration"("provider", "external_user_id");
