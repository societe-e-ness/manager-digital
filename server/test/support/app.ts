import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../src/app.module";
import { DatabaseService } from "../../src/core/database/database.service";

/** L'application complète, telle qu'en production, branchée sur la base de test. */
export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: ["error"] });
  await app.init();
  return app;
}

/** Vide toutes les tables (sauf l'historique des migrations) et remet les compteurs à zéro. */
export async function resetDatabase(db: DatabaseService) {
  const [{ name }] = await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  if (!name.endsWith("_test")) throw new Error(`Refus de vider la base "${name}" : ce n'est pas une base de test`);

  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = current_schema() AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;

  const list = tables.map((t) => `"${t.tablename}"`).join(", ");
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
