-- Les rôles auth.eness ne sont plus utilisés : les droits sont gérés dans le Manager Digital.
ALTER TABLE "session" DROP COLUMN "role";
