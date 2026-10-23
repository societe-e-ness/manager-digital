import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../database/database.module";
import { RightsModule } from "../rights/rights.module";
import { PluginAuthController } from "./plugin-auth.controller";
import { PluginAuthService } from "./plugin-auth.service";
import { PluginTokenGuard } from "./plugin-token.guard";

/**
 * Serveur d'autorisation OAuth 2.0 du Plugin WP. Les modules qui exposent des routes au
 * Plugin WP importent celui-ci et protègent leurs contrôleurs par PluginTokenGuard.
 */
@Module({
  imports: [DatabaseModule, AuthModule, RightsModule],
  controllers: [PluginAuthController],
  providers: [PluginAuthService, PluginTokenGuard],
  exports: [PluginAuthService, PluginTokenGuard],
})
export class PluginAuthModule {}
