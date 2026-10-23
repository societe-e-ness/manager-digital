import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_FILTER } from "@nestjs/core";
import { ScheduleModule } from "@nestjs/schedule";
import { AuthModule } from "./core/auth/auth.module";
import { DatabaseModule } from "./core/database/database.module";
import { HealthModule } from "./core/health/health.module";
import { IntegrationsModule } from "./core/integrations/integrations.module";
import { PluginAuthModule } from "./core/plugin-auth/plugin-auth.module";
import { PluginSocialModule } from "./core/plugin-social/plugin-social.module";
import { validateEnv } from "./core/config/env.schema";
import { ProblemDetailsFilter } from "./core/problems/problem-details.filter";

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
    AuthModule,
    HealthModule,
    IntegrationsModule,
    PluginAuthModule,
    PluginSocialModule,
  ],
  // Toutes les erreurs HTTP au format RFC 9457 (Problem Details)
  providers: [{ provide: APP_FILTER, useClass: ProblemDetailsFilter }],
})
export class AppModule {}
