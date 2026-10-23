-- Données de test uniquement : la table integration change de forme (colonnes NOT NULL ajoutées),
-- on la vide avant de la transformer.
DELETE FROM "integration";

-- CreateEnum
CREATE TYPE "user_type" AS ENUM ('AGENCY', 'CLIENT');

-- CreateEnum
CREATE TYPE "feature_effect" AS ENUM ('ADD', 'REMOVE');

-- CreateEnum
CREATE TYPE "login_method" AS ENUM ('SSO', 'MAGIC_LINK');

-- CreateEnum
CREATE TYPE "integration_provider" AS ENUM ('META');

-- CreateEnum
CREATE TYPE "integration_status" AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "resource_type" AS ENUM ('FACEBOOK_PAGE', 'INSTAGRAM_ACCOUNT', 'AD_ACCOUNT');

-- DropIndex
DROP INDEX "integration_siteId_adAccountId_key";

-- DropIndex
DROP INDEX "integration_status_expiresAt_idx";

-- AlterTable
ALTER TABLE "integration" DROP CONSTRAINT "integration_pkey",
DROP COLUMN "accessToken",
DROP COLUMN "adAccountId",
DROP COLUMN "adAccountName",
DROP COLUMN "createdAt",
DROP COLUMN "expiresAt",
DROP COLUMN "lastError",
DROP COLUMN "siteId",
DROP COLUMN "updatedAt",
ADD COLUMN     "access_token" TEXT NOT NULL,
ADD COLUMN     "client_id" INTEGER,
ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "created_by_id" INTEGER NOT NULL,
ADD COLUMN     "expires_at" TIMESTAMP(3),
ADD COLUMN     "external_user_id" TEXT NOT NULL,
ADD COLUMN     "provider" "integration_provider" NOT NULL,
ADD COLUMN     "scopes" TEXT[],
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
DROP COLUMN "status",
ADD COLUMN     "status" "integration_status" NOT NULL DEFAULT 'ACTIVE',
ADD CONSTRAINT "integration_pkey" PRIMARY KEY ("id");

-- DropTable
DROP TABLE "Feature";

-- DropTable
DROP TABLE "Role";

-- DropTable
DROP TABLE "User";

-- DropEnum
DROP TYPE "IntegrationStatus";

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "sso_subject" TEXT,
    "name" TEXT,
    "type" "user_type" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site" (
    "id" SERIAL NOT NULL,
    "domain" TEXT NOT NULL,
    "client_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_client" (
    "user_id" INTEGER NOT NULL,
    "client_id" INTEGER NOT NULL,

    CONSTRAINT "user_client_pkey" PRIMARY KEY ("user_id","client_id")
);

-- CreateTable
CREATE TABLE "pack" (
    "id" SERIAL NOT NULL,
    "slug" TEXT NOT NULL,
    "label" TEXT NOT NULL,

    CONSTRAINT "pack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature" (
    "id" SERIAL NOT NULL,
    "slug" TEXT NOT NULL,
    "label" TEXT NOT NULL,

    CONSTRAINT "feature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pack_feature" (
    "pack_id" INTEGER NOT NULL,
    "feature_id" INTEGER NOT NULL,

    CONSTRAINT "pack_feature_pkey" PRIMARY KEY ("pack_id","feature_id")
);

-- CreateTable
CREATE TABLE "user_pack" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "pack_id" INTEGER NOT NULL,
    "site_id" INTEGER,

    CONSTRAINT "user_pack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_feature" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "feature_id" INTEGER NOT NULL,
    "site_id" INTEGER,
    "effect" "feature_effect" NOT NULL,

    CONSTRAINT "user_feature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_feature" (
    "site_id" INTEGER NOT NULL,
    "feature_id" INTEGER NOT NULL,

    CONSTRAINT "site_feature_pkey" PRIMARY KEY ("site_id","feature_id")
);

-- CreateTable
CREATE TABLE "login_token" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "method" "login_method" NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_resource" (
    "id" SERIAL NOT NULL,
    "integration_id" INTEGER NOT NULL,
    "parent_id" INTEGER,
    "site_id" INTEGER,
    "type" "resource_type" NOT NULL,
    "external_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "access_token" TEXT,
    "metadata" JSONB,
    "last_synced_at" TIMESTAMP(3),
    "last_error" TEXT,

    CONSTRAINT "integration_resource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_sso_subject_key" ON "users"("sso_subject");

-- CreateIndex
CREATE UNIQUE INDEX "site_domain_key" ON "site"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "pack_slug_key" ON "pack"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "feature_slug_key" ON "feature"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "user_pack_user_id_pack_id_site_id_key" ON "user_pack"("user_id", "pack_id", "site_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_feature_user_id_feature_id_site_id_key" ON "user_feature"("user_id", "feature_id", "site_id");

-- CreateIndex
CREATE UNIQUE INDEX "login_token_hash_key" ON "login_token"("hash");

-- CreateIndex
CREATE UNIQUE INDEX "integration_resource_integration_id_type_external_id_key" ON "integration_resource"("integration_id", "type", "external_id");

-- CreateIndex
CREATE INDEX "integration_status_expires_at_idx" ON "integration"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "integration_provider_external_user_id_key" ON "integration"("provider", "external_user_id");

-- AddForeignKey
ALTER TABLE "site" ADD CONSTRAINT "site_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_client" ADD CONSTRAINT "user_client_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_client" ADD CONSTRAINT "user_client_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pack_feature" ADD CONSTRAINT "pack_feature_pack_id_fkey" FOREIGN KEY ("pack_id") REFERENCES "pack"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pack_feature" ADD CONSTRAINT "pack_feature_feature_id_fkey" FOREIGN KEY ("feature_id") REFERENCES "feature"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_pack" ADD CONSTRAINT "user_pack_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_pack" ADD CONSTRAINT "user_pack_pack_id_fkey" FOREIGN KEY ("pack_id") REFERENCES "pack"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_pack" ADD CONSTRAINT "user_pack_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_feature" ADD CONSTRAINT "user_feature_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_feature" ADD CONSTRAINT "user_feature_feature_id_fkey" FOREIGN KEY ("feature_id") REFERENCES "feature"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_feature" ADD CONSTRAINT "user_feature_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_feature" ADD CONSTRAINT "site_feature_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_feature" ADD CONSTRAINT "site_feature_feature_id_fkey" FOREIGN KEY ("feature_id") REFERENCES "feature"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_token" ADD CONSTRAINT "login_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration" ADD CONSTRAINT "integration_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration" ADD CONSTRAINT "integration_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_resource" ADD CONSTRAINT "integration_resource_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_resource" ADD CONSTRAINT "integration_resource_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_resource" ADD CONSTRAINT "integration_resource_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "integration_resource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────
-- Ajouté à la main : index uniques partiels.
-- En SQL, NULL ≠ NULL : l'index unique (user_id, pack_id, site_id) n'empêche pas
-- deux lignes identiques quand site_id est NULL ("tous les sites").
-- Prisma ne sait pas décrire ces index : si une migration future génère un
-- DROP INDEX sur l'un d'eux, retirer cette ligne de la migration.
-- ─────────────────────────────────────────────
CREATE UNIQUE INDEX "user_pack_user_id_pack_id_all_sites_key"
  ON "user_pack"("user_id", "pack_id") WHERE "site_id" IS NULL;

CREATE UNIQUE INDEX "user_feature_user_id_feature_id_all_sites_key"
  ON "user_feature"("user_id", "feature_id") WHERE "site_id" IS NULL;
