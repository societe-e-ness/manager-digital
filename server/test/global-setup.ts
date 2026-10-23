import { execSync } from "node:child_process";
import { config } from "dotenv";
import { testDatabaseUrl } from "./support/test-database";

/** Une fois avant toute la suite : applique les migrations sur la base de test. */
export default function globalSetup() {
  config({ quiet: true });
  const url = testDatabaseUrl();

  execSync("npx prisma migrate deploy", {
    cwd: `${__dirname}/..`,
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
    stdio: "inherit",
  });
}
