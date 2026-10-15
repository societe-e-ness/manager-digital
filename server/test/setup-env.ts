import { config } from "dotenv";
import { randomBytes } from "node:crypto";
import { testDatabaseUrl } from "./support/test-database";

// Lu avant chaque fichier de test : l'application démarre sur la base de test,
// avec une configuration fixe, quel que soit le contenu de .env.
config({ quiet: true });

process.env.DATABASE_URL = testDatabaseUrl();
process.env.DIRECT_URL = process.env.DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.APP_PUBLIC_URL = "http://localhost:3000";
process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.META_ENABLED = "true";
process.env.META_APP_ID = "test-app-id";
process.env.META_APP_SECRET = "test-app-secret";
