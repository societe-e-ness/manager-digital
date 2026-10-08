import { Module } from "@nestjs/common";
import { PrismaModule } from "./prisma/prisma.module";
import { HealthModule } from "./core/health/health.module";
import { ConfigModule } from "@nestjs/config";
import validationSchema from "./core/config/env.schema";

@Module({
  imports: [
    PrismaModule,
    HealthModule,
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema,
    }),
  ],
})
export class AppModule {}
