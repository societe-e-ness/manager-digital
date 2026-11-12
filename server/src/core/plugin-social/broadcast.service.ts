import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import type { Publication } from "../../generated/prisma/client";
import { DatabaseService } from "../database/database.service";
import { IntegrationsService } from "../integrations/integrations.service";
import { MetaService, metaFailureType } from "../integrations/meta.service";
import type { PluginPrincipal } from "../plugin-auth/plugin-auth.service";
import { ProblemException } from "../problems/problem.exception";
import { contentRefusals, NETWORK_RULES, type Refusal } from "./broadcast-rules";

/** Une image reçue du Plugin WP (multipart), gardée en mémoire le temps de la Diffusion. */
export interface UploadedImage {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

/** Le résultat de la vérification : les refus prévisibles de chaque Ressource cible. */
export interface BroadcastCheck {
  ok: boolean;
  targets: { resourceId: number; refusals: Refusal[] }[];
}

/** Une Diffusion : une Actualité vers des Ressources du Site, avec un texte par Ressource. */
export interface BroadcastRequest {
  article: { id: string; url: string };
  targets: { resourceId: number; text: string }[];
  images: UploadedImage[];
}

/**
 * Diffusion d'une Actualité : une Publication diffusée par Ressource cible, tracée avant l'envoi
 * (statut en cours) puis mise à jour (réussie ou échouée).
 *
 * Deux sortes d'échecs :
 *  - les refus prévisibles, déduits sans appeler Meta (Intégration expirée, permission manquante,
 *    texte trop long, images non acceptées…) : un seul suffit à bloquer TOUTE la Diffusion, avant
 *    tout envoi et sans rien tracer (422 `broadcast-refused`). Le Plugin WP peut les demander à
 *    l'avance, sans rien envoyer (`check`) ;
 *  - les échecs imprévisibles, renvoyés par Meta pendant l'envoi : ils ne bloquent que leur
 *    Publication, tracée échouée ; les autres Ressources sont servies quand même.
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

  /**
   * Les refus prévisibles de chaque Ressource cible, sans rien envoyer ni tracer. Une cible non
   * rattachée au Site du jeton n'est pas un refus mais une demande invalide : 422 `resource-not-attached`.
   */
  async check(plugin: PluginPrincipal, request: BroadcastRequest): Promise<BroadcastCheck> {
    return (await this.evaluate(plugin, request)).verdict;
  }

  /** La vérification, avec ce qu'elle a lu : les Ressources du Site et son Client, pour l'envoi qui suit. */
  private async evaluate(plugin: PluginPrincipal, request: BroadcastRequest) {
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

    const clientId = await this.integrations.siteClientId(plugin.siteId);
    const targets = [];
    for (const target of request.targets) {
      const resource = resources.get(target.resourceId)!;
      const rules = NETWORK_RULES[resource.type];
      const refusals: Refusal[] = [];
      if (!rules) {
        refusals.push({ type: "resource-type-unsupported", detail: "Ce type de Ressource ne peut pas (encore) recevoir de Diffusion" });
      } else {
        // l'accès d'abord : sans Intégration active, inutile de parler de permissions
        if (!(await this.integrations.hasActiveAccess(resource.id, clientId))) {
          refusals.push({ type: "integration-expired", detail: "Aucune Intégration active ne mène à cette Ressource : reconnecter le compte Meta" });
        } else if (!(await this.integrations.hasActiveAccess(resource.id, clientId, rules.scopes))) {
          refusals.push({
            type: "permission-missing",
            detail: "Le compte Meta n'a pas accordé la permission de publier : le reconnecter pour l'accorder",
            requiredScopes: rules.scopes,
          });
        }
        refusals.push(...contentRefusals(rules, target.text, request.images));
      }
      targets.push({ resourceId: target.resourceId, refusals });
    }
    const verdict: BroadcastCheck = { ok: targets.every((t) => t.refusals.length === 0), targets };
    return { verdict, resources, clientId };
  }

  /** social.publish sur le Site est vérifié par la garde du jeton, avant même la réception des images. */
  async broadcast(plugin: PluginPrincipal, request: BroadcastRequest) {
    const { verdict, resources, clientId } = await this.evaluate(plugin, request);
    if (!verdict.ok) {
      throw new ProblemException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        "broadcast-refused",
        "Diffusion refusée",
        "Au moins une Ressource cible refuserait cette Diffusion : rien n'a été envoyé",
        { targets: verdict.targets },
      );
    }

    const publications: Publication[] = [];
    for (const target of request.targets) {
      const resource = resources.get(target.resourceId)!;
      publications.push(await this.publish(plugin, clientId, request, target, resource.external_id, NETWORK_RULES[resource.type]!.scopes));
    }
    return publications;
  }

  private async publish(
    plugin: PluginPrincipal,
    clientId: number,
    request: BroadcastRequest,
    target: { resourceId: number; text: string },
    pageExternalId: string,
    requiredScopes: string[],
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
      // une Intégration qui a accordé la publication (la vérification a montré qu'il y en avait une)
      const access = await this.integrations.activeAccess(target.resourceId, clientId, requiredScopes);
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
