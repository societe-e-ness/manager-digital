import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { DatabaseModule } from "./core/database/database.module";
import { HealthModule } from "./core/health/health.module";
import { IntegrationsModule } from "./core/integrations/integrations.module";
import { validateEnv } from "./core/config/env.schema";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // `validationSchema` attend un schéma Joi (méthode .validate) ;
      // avec zod on passe par `validate`.
      validate: validateEnv,
    }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    HealthModule,
    IntegrationsModule,
  ],
})
export class AppModule {}
