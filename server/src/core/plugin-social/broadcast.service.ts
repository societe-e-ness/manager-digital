import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import type { Publication } from "../../generated/prisma/client";
import { DatabaseService } from "../database/database.service";
import { IntegrationsService } from "../integrations/integrations.service";
import { MetaService, metaFailureType } from "../integrations/meta.service";
import type { PluginPrincipal } from "../plugin-auth/plugin-auth.service";
import { ProblemException } from "../problems/problem.exception";

/** Une image reçue du Plugin WP (multipart), gardée en mémoire le temps de la Diffusion. */
export interface UploadedImage {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
}

/** Une Diffusion : une Actualité vers des Ressources du Site, avec un texte par Ressource. */
export interface BroadcastRequest {
  article: { id: string; url: string };
  targets: { resourceId: number; text: string }[];
  images: UploadedImage[];
}

/**
 * Diffusion d'une Actualité : une Publication diffusée par Ressource cible, tracée avant l'envoi
 * (statut en cours) puis mise à jour (réussie ou échouée). L'échec d'une Ressource n'empêche pas
 * les autres.
 */
@Injectable()
export class BroadcastService {
  private readonly logger = new Logger(BroadcastService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly integrations: IntegrationsService,
    private readonly meta: MetaService,
  ) {}

  /** Lit les champs multipart : `actualite` et `targets` sont du JSON. */
  parseRequest(fields: Record<string, unknown>, images: UploadedImage[]): BroadcastRequest {
    const invalid = (detail: string) =>
      new ProblemException(HttpStatus.BAD_REQUEST, "broadcast-invalid-request", "Diffusion invalide", detail);
    const json = (name: string) => {
      if (typeof fields[name] !== "string") throw invalid(`champ ${name} requis (JSON)`);
      try {
        return JSON.parse(fields[name]);
      } catch {
        throw invalid(`champ ${name} : JSON illisible`);
      }
    };

    const article = json("actualite");
    const articleId = typeof article?.id === "number" ? String(article.id) : article?.id;
    if (typeof articleId !== "string" || !articleId) throw invalid("actualite.id requis (identifiant WordPress)");
    if (typeof article.url !== "string" || !/^https?:\/\//.test(article.url)) throw invalid("actualite.url requis (lien de l'Actualité)");

    const targets = json("targets");
    if (!Array.isArray(targets) || targets.length === 0) throw invalid("targets : au moins une Ressource cible");
    for (const t of targets) {
      if (!Number.isInteger(t?.resourceId) || typeof t?.text !== "string") throw invalid("targets : { resourceId, text } attendus");
    }
    if (new Set(targets.map((t) => t.resourceId)).size !== targets.length) throw invalid("targets : une Ressource en double");

    return {
      article: { id: articleId, url: article.url },
      targets: targets.map((t) => ({ resourceId: t.resourceId, text: t.text })),
      images,
    };
  }

  /** social.publish sur le Site est vérifié par la garde du jeton, avant même la réception des images. */
  async broadcast(plugin: PluginPrincipal, request: BroadcastRequest) {
    // toutes les cibles doivent être rattachées au Site du jeton : sinon rien ne part
    const resources = new Map((await this.integrations.listSiteResources(plugin.siteId)).map((r) => [r.id, r]));
    const notAttached = request.targets.map((t) => t.resourceId).filter((id) => !resources.has(id));
    if (notAttached.length > 0) {
      throw new ProblemException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        "resource-not-attached",
        "Ressource non rattachée au Site",
        "Une Diffusion ne vise que des Ressources rattachées au Site du Plugin WP",
        { resourceIds: notAttached },
      );
    }
    const unsupported = request.targets.map((t) => t.resourceId).filter((id) => resources.get(id)!.type !== "FACEBOOK_PAGE");
    if (unsupported.length > 0) {
      throw new ProblemException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        "resource-type-unsupported",
        "Ressource non prise en charge",
        "Seules les pages Facebook peuvent recevoir une Diffusion pour l'instant",
        { resourceIds: unsupported },
      );
    }

    const clientId = await this.integrations.siteClientId(plugin.siteId);
    const publications: Publication[] = [];
    for (const target of request.targets) {
      publications.push(await this.publish(plugin, clientId, request, target, resources.get(target.resourceId)!.external_id));
    }
    return publications;
  }

  private async publish(
    plugin: PluginPrincipal,
    clientId: number,
    request: BroadcastRequest,
    target: { resourceId: number; text: string },
    pageExternalId: string,
  ) {
    const publication = await this.db.publication.create({
      data: {
        site_id: plugin.siteId,
        article_id: request.article.id,
        article_url: request.article.url,
        resource_id: target.resourceId,
        text: target.text,
        author_id: plugin.user.id,
      },
    });

    try {
      const access = await this.integrations.activeAccess(target.resourceId, clientId);
      if (!access) {
        return this.fail(publication.id, "integration-expired", "Aucune Intégration active ne mène à cette Ressource");
      }
      const post = await this.meta.publishToPage(access.integration, access.pageToken, pageExternalId, {
        message: target.text,
        link: request.article.url,
        images: request.images.map((i) => ({ buffer: i.buffer, mimetype: i.mimetype, filename: i.originalname })),
      });
      return this.db.publication.update({
        where: { id: publication.id },
        data: { status: "SUCCEEDED", network_post_id: post.postId, network_url: post.url, published_at: new Date() },
      });
    } catch (e) {
      const type = metaFailureType(e);
      if (type) return this.fail(publication.id, type, e instanceof Error ? e.message : String(e));
      // pas une erreur de Meta : un bogue ou une panne chez nous, à ne pas déguiser en panne réseau
      this.logger.error(`Diffusion ${publication.id} : ${e instanceof Error ? e.stack : String(e)}`);
      return this.fail(publication.id, "internal-error", "Erreur interne du Manager Digital");
    }
  }

  private fail(id: number, type: string, detail: string) {
    return this.db.publication.update({ where: { id }, data: { status: "FAILED", error_type: type, error_detail: detail } });
  }
}
