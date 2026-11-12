import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query, UseGuards } from "@nestjs/common";
import { Public } from "../auth/session.guard";
import { IntegrationsService } from "../integrations/integrations.service";
import type { PluginPrincipal } from "../plugin-auth/plugin-auth.service";
import { CurrentPlugin, PluginTokenGuard, RequiresAnyFeature } from "../plugin-auth/plugin-token.guard";
import { Features } from "../rights/rights.service";
import { BroadcastService } from "./broadcast.service";
import { PublicationsFeedService } from "./publications-feed.service";

/**
 * Les routes appelées par le Plugin WP, avec son jeton (`Authorization: Bearer …`).
 * Le Site vient toujours du jeton, jamais d'un paramètre.
 *
 *   GET  /plugin/resources  → les Ressources rattachées au Site, avec leur état (`accessible`) ;
 *                             exige social.read ou social.publish sur le Site
 *   POST /plugin/broadcasts → diffuse une Actualité (JSON) ; exige social.publish :
 *                             { actualite: { id: "42", url: "https://…" },
 *                               images: [{ url: "https://…/photo.jpg", mimeType, width, height, size }] (facultatif),
 *                               targets: [{ resourceId: 1, text: "…", format: "post" | "story" }] }
 *                             Les images sont des URL publiques (médiathèque WordPress) : Meta va les chercher.
 *                             → 201 { publications } : une Publication diffusée par Ressource, avec son statut
 *                             → 422 broadcast-refused { targets } s'il y a un refus prévisible : rien n'est envoyé
 *   POST /plugin/broadcasts/check → la même requête, vérifiée sans rien envoyer ; exige social.publish :
 *                             → 200 { ok, targets: [{ resourceId, refusals: [{ type, detail, … }] }] }
 *   POST /plugin/publications/:id/retry → relance une Publication échouée du Site, avec le même contenu
 *                             (texte, lien, format, images enregistrés) ; exige social.publish ; sans corps
 *                             → 200 la Publication mise à jour ; 409 si elle est réussie ou en cours d'envoi ;
 *                             422 broadcast-refused s'il y a un refus prévisible
 *   GET  /plugin/articles/:articleId/publications → l'historique d'une Actualité : ses Publications
 *                             diffusées sur ce Site, avec leur Ressource ; exige social.read ou social.publish
 *   GET  /plugin/publications?page=1&limit=20&resourceId=…
 *                           → les Publications récentes des pages et comptes Instagram du Site (lues chez
 *                             Meta, cache de quelques minutes), de la plus récente à la plus ancienne ;
 *                             exige social.read. { publications, page, limit, hasMore, unavailable }
 */
@Public() // pas de session : la garde du jeton du Plugin WP la remplace
@UseGuards(PluginTokenGuard)
@Controller("plugin")
export class PluginSocialController {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly broadcasts: BroadcastService,
    private readonly feed: PublicationsFeedService,
  ) {}

  @Get("publications")
  @RequiresAnyFeature(Features.SOCIAL_READ)
  publications(
    @CurrentPlugin() plugin: PluginPrincipal,
    @Query("page", new ParseIntPipe({ optional: true })) page = 1,
    @Query("limit", new ParseIntPipe({ optional: true })) limit = 20,
    @Query("resourceId", new ParseIntPipe({ optional: true })) resourceId?: number,
  ) {
    return this.feed.list(plugin, { page: Math.max(1, page), limit: Math.min(50, Math.max(1, limit)), resourceId });
  }

  // consulter ou diffuser : dans les deux cas, le Plugin WP a besoin des Ressources du Site
  @Get("resources")
  @RequiresAnyFeature(Features.SOCIAL_READ, Features.SOCIAL_PUBLISH)
  async resources(@CurrentPlugin() plugin: PluginPrincipal) {
    const resources = await this.integrations.listSiteResources(plugin.siteId);
    return resources.map((r) => this.integrations.toPublicResource(r, "all"));
  }

  @Post("publications/:id/retry")
  @HttpCode(200)
  @RequiresAnyFeature(Features.SOCIAL_PUBLISH)
  retry(@CurrentPlugin() plugin: PluginPrincipal, @Param("id", ParseIntPipe) id: number) {
    return this.broadcasts.retry(plugin, id);
  }

  @Get("articles/:articleId/publications")
  @RequiresAnyFeature(Features.SOCIAL_READ, Features.SOCIAL_PUBLISH)
  history(@CurrentPlugin() plugin: PluginPrincipal, @Param("articleId") articleId: string) {
    return this.broadcasts.history(plugin, articleId);
  }

  @Post("broadcasts/check")
  @HttpCode(200)
  @RequiresAnyFeature(Features.SOCIAL_PUBLISH)
  check(@CurrentPlugin() plugin: PluginPrincipal, @Body() body: unknown) {
    return this.broadcasts.check(plugin, this.broadcasts.parseRequest(body));
  }

  @Post("broadcasts")
  @RequiresAnyFeature(Features.SOCIAL_PUBLISH)
  async broadcast(@CurrentPlugin() plugin: PluginPrincipal, @Body() body: unknown) {
    const request = this.broadcasts.parseRequest(body);
    return { publications: await this.broadcasts.broadcast(plugin, request) };
  }
}
