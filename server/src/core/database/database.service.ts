import { Injectable, OnModuleInit } from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "src/generated/prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL }); // me manque ceci, créer une bdd

@Injectable()
export class DatabaseService extends PrismaClient implements OnModuleInit {
  // relire expli. intégration Prisma
  constructor() {
    super({ adapter });
  }

  async onModuleInit() {
    await this.$connect();
  }
}
