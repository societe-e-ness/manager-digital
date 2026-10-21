import { Controller, Get, UseGuards } from "@nestjs/common";
import { Public } from "../auth/session.guard";
import { IntegrationsService } from "../integrations/integrations.service";
import type { PluginPrincipal } from "../plugin-auth/plugin-auth.service";
import { CurrentPlugin, PluginTokenGuard } from "../plugin-auth/plugin-token.guard";
import { Features, missingFeature, RightsService } from "../rights/rights.service";

/**
 * Les routes appelées par le Plugin WP, avec son jeton (`Authorization: Bearer …`).
 * Le Site vient toujours du jeton, jamais d'un paramètre.
 *
 *   GET /plugin/resources → les Ressources rattachées au Site, avec leur état (`accessible`) ;
 *                           exige social.read ou social.publish sur le Site
 */
@Public() // pas de session : la garde du jeton du Plugin WP la remplace
@UseGuards(PluginTokenGuard)
@Controller("plugin")
export class PluginSocialController {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly rights: RightsService,
  ) {}

  @Get("resources")
  async resources(@CurrentPlugin() plugin: PluginPrincipal) {
    // consulter ou diffuser : dans les deux cas, le Plugin WP a besoin des Ressources du Site
    const scope = { siteId: plugin.siteId };
    const allowed = await Promise.all(
      [Features.SOCIAL_READ, Features.SOCIAL_PUBLISH].map((slug) => this.rights.hasFeature(plugin.user, slug, scope)),
    );
    if (!allowed.includes(true)) throw missingFeature(Features.SOCIAL_READ);

    const resources = await this.integrations.listSiteResources(plugin.siteId);
    return resources.map((r) => this.integrations.toPublicResource(r, "all"));
  }
}
