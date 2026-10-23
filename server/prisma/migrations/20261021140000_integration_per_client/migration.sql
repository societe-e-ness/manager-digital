-- Une Intégration par compte Meta ET par Client (ticket 06).
-- Avant, reconnecter pour le Client A un compte déjà connecté pour le Client B mettait à jour
-- l'Intégration de B. Désormais, chaque Client a la sienne ; les Ressources restent partagées.
-- Données existantes : aucune modification (l'ancienne contrainte est plus stricte que la nouvelle).

DROP INDEX "integration_provider_external_user_id_key";

CREATE UNIQUE INDEX "integration_provider_external_user_id_client_id_key" ON "integration"("provider", "external_user_id", "client_id");

-- NULL ≠ NULL en SQL : l'index ci-dessus n'empêche pas deux accès de l'agence (client_id NULL)
-- pour le même compte. Index partiel, inconnu de Prisma.
CREATE UNIQUE INDEX "integration_provider_external_user_id_agency_key"
  ON "integration"("provider", "external_user_id") WHERE "client_id" IS NULL;
