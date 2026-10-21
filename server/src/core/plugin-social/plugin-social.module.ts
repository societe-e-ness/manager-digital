import { Module } from "@nestjs/common";
import { IntegrationsModule } from "../integrations/integrations.module";
import { PluginAuthModule } from "../plugin-auth/plugin-auth.module";
import { RightsModule } from "../rights/rights.module"; // pour PluginTokenGuard
import { DatabaseModule } from "../database/database.module";
import { BroadcastService } from "./broadcast.service";
import { PluginSocialController } from "./plugin-social.controller";

/** Réseaux sociaux du Plugin WP : Ressources du Site (puis Publications, Diffusion, historique). */
@Module({
  imports: [DatabaseModule, IntegrationsModule, PluginAuthModule, RightsModule],
  controllers: [PluginSocialController],
  providers: [BroadcastService],
})
export class PluginSocialModule {}
