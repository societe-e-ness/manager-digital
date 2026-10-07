import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
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
      throw new ServiceUnavailableException(result);
    }
    return result;
  }
}
