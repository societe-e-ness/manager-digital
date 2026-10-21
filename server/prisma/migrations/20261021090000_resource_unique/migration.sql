-- Une page = une Ressource (ticket 05).
--
-- Avant : integration_resource = une ressource PAR Intégration. Deux personnes qui connectent
-- la même page produisent deux lignes.
-- Après : resource = une ressource par (réseau, type, identifiant externe), et
-- integration_resource devient le lien Intégration ↔ Ressource, qui garde le jeton de page.
--
-- Données existantes : elles sont conservées.
--  - Les doublons d'une même page fusionnent en une seule Ressource. On garde la ligne
--    rattachée à un Site s'il y en a une, sinon la plus récemment synchronisée
--    (nom, métadonnées, rattachement).
--  - Chaque ancienne ligne devient un lien, avec son jeton de page.
--  - Le parent (page d'un compte Instagram) est recalculé vers la Ressource fusionnée ; s'il
--    différait selon l'Intégration, celui de la ligne la plus récemment synchronisée l'emporte.
--  - Limite : une Ressource n'a qu'un Site. Si des copies d'une même page étaient rattachées à
--    des Sites différents, un seul rattachement est gardé (cas hors périmètre, non rencontré).
--
-- Retour arrière : down.sql, valable sur une base vide uniquement (il ne recrée pas les doublons).

-- 1. La table des Ressources
CREATE TABLE "resource" (
    "id" SERIAL NOT NULL,
    "provider" "integration_provider" NOT NULL,
    "type" "resource_type" NOT NULL,
    "external_id" TEXT NOT NULL,
    "parent_id" INTEGER,
    "site_id" INTEGER,
    "name" TEXT NOT NULL,
    "metadata" JSONB,
    "last_synced_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resource_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "resource_provider_type_external_id_key" ON "resource"("provider", "type", "external_id");

-- 2. Une Ressource par page, compte Instagram ou compte publicitaire déjà connu
INSERT INTO "resource" ("provider", "type", "external_id", "site_id", "name", "metadata", "last_synced_at", "last_error")
SELECT DISTINCT ON (i."provider", r."type", r."external_id")
       i."provider", r."type", r."external_id", r."site_id", r."name", r."metadata", r."last_synced_at", r."last_error"
FROM "integration_resource" r
JOIN "integration" i ON i."id" = r."integration_id"
ORDER BY i."provider", r."type", r."external_id", (r."site_id" IS NULL), r."last_synced_at" DESC NULLS LAST, r."id" DESC;

UPDATE "resource" child
SET "parent_id" = parent."id"
FROM (
    SELECT DISTINCT ON (i."provider", r."type", r."external_id")
           i."provider", r."type", r."external_id", p."type" AS "parent_type", p."external_id" AS "parent_external_id"
    FROM "integration_resource" r
    JOIN "integration" i ON i."id" = r."integration_id"
    JOIN "integration_resource" p ON p."id" = r."parent_id"
    ORDER BY i."provider", r."type", r."external_id", r."last_synced_at" DESC NULLS LAST, r."id" DESC
) old
JOIN "resource" parent ON parent."provider" = old."provider" AND parent."type" = old."parent_type" AND parent."external_id" = old."parent_external_id"
WHERE child."provider" = old."provider" AND child."type" = old."type" AND child."external_id" = old."external_id";

-- 3. integration_resource devient le lien Intégration ↔ Ressource
ALTER TABLE "integration_resource" ADD COLUMN "resource_id" INTEGER;

UPDATE "integration_resource" r
SET "resource_id" = res."id"
FROM "integration" i, "resource" res
WHERE i."id" = r."integration_id"
  AND res."provider" = i."provider" AND res."type" = r."type" AND res."external_id" = r."external_id";

ALTER TABLE "integration_resource" DROP CONSTRAINT "integration_resource_site_id_fkey";
ALTER TABLE "integration_resource" DROP CONSTRAINT "integration_resource_parent_id_fkey";
DROP INDEX "integration_resource_integration_id_type_external_id_key";

ALTER TABLE "integration_resource" DROP CONSTRAINT "integration_resource_pkey",
DROP COLUMN "external_id",
DROP COLUMN "id",
DROP COLUMN "last_error",
DROP COLUMN "last_synced_at",
DROP COLUMN "metadata",
DROP COLUMN "name",
DROP COLUMN "parent_id",
DROP COLUMN "site_id",
DROP COLUMN "type",
ALTER COLUMN "resource_id" SET NOT NULL,
ADD CONSTRAINT "integration_resource_pkey" PRIMARY KEY ("integration_id", "resource_id");

CREATE INDEX "integration_resource_resource_id_idx" ON "integration_resource"("resource_id");

-- 4. Clés étrangères
ALTER TABLE "resource" ADD CONSTRAINT "resource_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "resource" ADD CONSTRAINT "resource_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "resource"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "integration_resource" ADD CONSTRAINT "integration_resource_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "resource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
