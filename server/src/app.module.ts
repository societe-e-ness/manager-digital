import { Module } from "@nestjs/common";
import { PrismaModule } from "./prisma/prisma.module";
import { HealthModule } from "./core/health/health.module";

@Module({
  imports: [PrismaModule, HealthModule],
})
export class AppModule {}
