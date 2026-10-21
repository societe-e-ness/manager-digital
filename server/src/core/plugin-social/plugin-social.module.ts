import { Module } from "@nestjs/common";
import { IntegrationsModule } from "../integrations/integrations.module";
import { PluginAuthModule } from "../plugin-auth/plugin-auth.module";
import { RightsModule } from "../rights/rights.module";
import { PluginSocialController } from "./plugin-social.controller";

/** Réseaux sociaux du Plugin WP : Ressources du Site (puis Publications, Diffusion, historique). */
@Module({
  imports: [IntegrationsModule, PluginAuthModule, RightsModule],
  controllers: [PluginSocialController],
})
export class PluginSocialModule {}
