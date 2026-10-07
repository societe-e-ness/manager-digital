import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";

export type HealthStatus = {
  status: "ok" | "error";
  timestamp: string;
  details?: Record<string, string>;
};

@Injectable()
export class HealthService {
  constructor(private readonly databaseService: DatabaseService) {}

  check(): HealthStatus {
    return { status: "ok", timestamp: new Date().toISOString() };
  }

  async checkReady() {
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
      const message = e instanceof Error ? e.message : String(e);
      return { status: "error", timestamp, details: { database: message } };
    }
  }
}
