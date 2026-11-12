-- Relance des Publications (ticket 11) : nombre d'images envoyées (une relance doit les joindre de
-- nouveau, elles ne sont pas conservées) et début du dernier envoi (une Publication restée « en cours »
-- trop longtemps, par exemple après une coupure pendant l'envoi, peut être relancée).

-- AlterTable
ALTER TABLE "publication" ADD COLUMN     "attempted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "image_count" INTEGER NOT NULL DEFAULT 0;

-- les Publications existantes : leur dernier envoi est leur Diffusion
UPDATE "publication" SET "attempted_at" = "created_at";
