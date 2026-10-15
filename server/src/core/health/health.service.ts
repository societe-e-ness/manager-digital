import { Injectable, Logger } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";

export type HealthStatus = {
  status: "ok" | "error";
  timestamp: string;
  details?: Record<string, string>;
};

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(private readonly databaseService: DatabaseService) {}

  check(): HealthStatus {
    return { status: "ok", timestamp: new Date().toISOString() };
  }

  async checkReady(): Promise<HealthStatus> {
    const timestamp = new Date().toISOString();
    try {
      // pas le seul service testé à terme
      await this.databaseService.$queryRaw`SELECT 1`;
      return {
        status: "ok",
        timestamp,
        details: { database: "up" },
      };
    } catch (e) {
      // le message du driver (hôte, utilisateur…) reste dans les logs : la route est publique
      this.logger.error(`Base de données injoignable : ${e instanceof Error ? e.message : String(e)}`);
      return { status: "error", timestamp, details: { database: "down" } };
    }
  }
}
