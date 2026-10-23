/**
 * L'URL de la base de test, lue dans TEST_DATABASE_URL.
 * Garde-fou : les tests vident la base entre chaque test, elle doit donc être
 * distincte de DATABASE_URL / DIRECT_URL et son nom doit finir par "_test".
 */
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error("TEST_DATABASE_URL manquante : renseigner une base PostgreSQL dédiée aux tests dans server/.env");
  }
  if (url === process.env.DATABASE_URL || url === process.env.DIRECT_URL) {
    throw new Error("TEST_DATABASE_URL doit être différente de DATABASE_URL et DIRECT_URL");
  }
  const name = new URL(url).pathname.slice(1);
  if (!name.endsWith("_test")) {
    throw new Error(`Le nom de la base de test doit finir par "_test" (reçu : "${name}")`);
  }
  return url;
}
