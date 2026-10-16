-- AlterTable
ALTER TABLE "session" ADD COLUMN     "checked_at" TIMESTAMP(3),
ADD COLUMN     "id_token" TEXT,
ADD COLUMN     "refresh_token" TEXT,
ADD COLUMN     "role" TEXT,
ADD COLUMN     "sso_sid" TEXT;

-- CreateIndex
CREATE INDEX "session_sso_sid_idx" ON "session"("sso_sid");
