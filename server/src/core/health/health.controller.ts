import { Controller, Get, HttpStatus } from "@nestjs/common";
import { ProblemException } from "../problems/problem.exception";
import { HealthService } from "./health.service";
import type { HealthStatus } from "./health.service";

@Controller("health")
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  check(): HealthStatus {
    return this.healthService.check();
  }

  @Get("ready")
  async checkReady(): Promise<HealthStatus> {
    const result = await this.healthService.checkReady();
    if (result.status === "error") {
      throw new ProblemException(HttpStatus.SERVICE_UNAVAILABLE, "service-unavailable", "Service indisponible", "Une dépendance ne répond pas", {
        details: result.details,
      });
    }
    return result;
  }
}
