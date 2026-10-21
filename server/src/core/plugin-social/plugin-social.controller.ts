import { Body, Controller, Get, Post, UploadedFiles, UseGuards, UseInterceptors } from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import { Public } from "../auth/session.guard";
import { IntegrationsService } from "../integrations/integrations.service";
import type { PluginPrincipal } from "../plugin-auth/plugin-auth.service";
import { CurrentPlugin, PluginTokenGuard, RequiresAnyFeature } from "../plugin-auth/plugin-token.guard";
import { Features } from "../rights/rights.service";
import { BroadcastService, type UploadedImage } from "./broadcast.service";

// images d'une Diffusion : gardées en mémoire le temps de l'envoi, jamais écrites sur disque
const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Les routes appelées par le Plugin WP, avec son jeton (`Authorization: Bearer …`).
 * Le Site vient toujours du jeton, jamais d'un paramètre.
 *
 *   GET  /plugin/resources  → les Ressources rattachées au Site, avec leur état (`accessible`) ;
 *                             exige social.read ou social.publish sur le Site
 *   POST /plugin/broadcasts → diffuse une Actualité (multipart/form-data) ; exige social.publish :
 *                             actualite = {"id":"42","url":"https://…"} (JSON)
 *                             targets   = [{"resourceId":1,"text":"…"}] (JSON, un texte par Ressource)
 *                             images    = fichiers (facultatif, 10 au plus)
 *                             → 201 { publications } : une Publication diffusée par Ressource, avec son statut
 */
@Public() // pas de session : la garde du jeton du Plugin WP la remplace
@UseGuards(PluginTokenGuard)
@Controller("plugin")
export class PluginSocialController {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly broadcasts: BroadcastService,
  ) {}

  // consulter ou diffuser : dans les deux cas, le Plugin WP a besoin des Ressources du Site
  @Get("resources")
  @RequiresAnyFeature(Features.SOCIAL_READ, Features.SOCIAL_PUBLISH)
  async resources(@CurrentPlugin() plugin: PluginPrincipal) {
    const resources = await this.integrations.listSiteResources(plugin.siteId);
    return resources.map((r) => this.integrations.toPublicResource(r, "all"));
  }

  @Post("broadcasts")
  @RequiresAnyFeature(Features.SOCIAL_PUBLISH)
  @UseInterceptors(FilesInterceptor("images", MAX_IMAGES, { limits: { fileSize: MAX_IMAGE_BYTES } }))
  async broadcast(
    @CurrentPlugin() plugin: PluginPrincipal,
    @Body() fields: Record<string, unknown>,
    @UploadedFiles() images: UploadedImage[] = [],
  ) {
    const request = this.broadcasts.parseRequest(fields ?? {}, images);
    return { publications: await this.broadcasts.broadcast(plugin, request) };
  }
}
