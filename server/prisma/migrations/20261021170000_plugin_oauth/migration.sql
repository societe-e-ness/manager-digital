-- Plugin WP : OAuth 2.0 (code d'autorisation + PKCE), ticket 07. Nouvelles tables, aucune donnée touchée.
-- CreateTable
CREATE TABLE "plugin_authorization_code" (
    "id" SERIAL NOT NULL,
    "hash" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "site_id" INTEGER NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "code_challenge" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plugin_authorization_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plugin_authorization" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "site_id" INTEGER NOT NULL,
    "token_hash" TEXT NOT NULL,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plugin_authorization_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plugin_authorization_code_hash_key" ON "plugin_authorization_code"("hash");

-- CreateIndex
CREATE UNIQUE INDEX "plugin_authorization_token_hash_key" ON "plugin_authorization"("token_hash");

-- CreateIndex
CREATE INDEX "plugin_authorization_user_id_site_id_idx" ON "plugin_authorization"("user_id", "site_id");

-- AddForeignKey
ALTER TABLE "plugin_authorization_code" ADD CONSTRAINT "plugin_authorization_code_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plugin_authorization_code" ADD CONSTRAINT "plugin_authorization_code_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plugin_authorization" ADD CONSTRAINT "plugin_authorization_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plugin_authorization" ADD CONSTRAINT "plugin_authorization_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

