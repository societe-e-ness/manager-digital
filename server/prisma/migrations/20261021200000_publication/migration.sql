-- Publications diffusées depuis le Plugin WP (ticket 08). Nouvelle table, aucune donnée touchée.
-- CreateEnum
CREATE TYPE "publication_status" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "publication" (
    "id" SERIAL NOT NULL,
    "site_id" INTEGER NOT NULL,
    "article_id" TEXT NOT NULL,
    "article_url" TEXT NOT NULL,
    "resource_id" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "status" "publication_status" NOT NULL DEFAULT 'PENDING',
    "error_type" TEXT,
    "error_detail" TEXT,
    "network_post_id" TEXT,
    "network_url" TEXT,
    "author_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "publication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "publication_site_id_article_id_idx" ON "publication"("site_id", "article_id");

-- AddForeignKey
ALTER TABLE "publication" ADD CONSTRAINT "publication_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publication" ADD CONSTRAINT "publication_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "resource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publication" ADD CONSTRAINT "publication_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

