import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import type { Prisma, Publication, Resource } from "../../generated/prisma/client";
import { DatabaseService } from "../database/database.service";
import { IntegrationsService } from "../integrations/integrations.service";
import { MetaService, metaFailureType } from "../integrations/meta.service";
import type { PluginPrincipal } from "../plugin-auth/plugin-auth.service";
import { ProblemException } from "../problems/problem.exception";
import { contentRefusals, NETWORK_RULES, type ImageRef, type PublicationFormat, type Refusal } from "./broadcast-rules";

// une Publication « en cours » depuis plus longtemps a été interrompue (coupure pendant l'envoi) :
// elle peut être relancée. Bien au-delà de la durée maximale d'une requête.
const STALE_PENDING_MS = 15 * 60 * 1000;

/** Le résultat de la vérification : les refus prévisibles de chaque Ressource cible. */
export interface BroadcastCheck {
  ok: boolean;
  targets: { resourceId: number; refusals: Refusal[] }[];
}

/** Une cible : une Ressource du Site, son texte et son format (`post` par défaut). */
export interface BroadcastTarget {
  resourceId: number;
  text: string;
  format: string;
}

/** Une Diffusion : une Actualité vers des Ressources du Site, avec des images décrites par leur URL. */
export interface BroadcastRequest {
  article: { id: string; url: string };
  targets: BroadcastTarget[];
  images: ImageRef[];
}

/**
 * Diffusion d'une Actualité : une Publication diffusée par Ressource cible, tracée avant l'envoi
 * (statut en cours) puis mise à jour (réussie ou échouée). Les images ne transitent pas par le
 * Manager Digital : ce sont des URL publiques de la médiathèque WordPress, que Meta va chercher.
 *
 * Deux sortes d'échecs :
 *  - les refus prévisibles, déduits sans appeler Meta (Intégration expirée, permission manquante,
 *    format non pris en charge, texte trop long, images non acceptées…) : un seul suffit à bloquer
 *    TOUTE la Diffusion, avant tout envoi et sans rien tracer (422 `broadcast-refused`). Le Plugin WP
 *    peut les demander à l'avance, sans rien envoyer (`check`) ;
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

  /** Lit le corps JSON d'une Diffusion (ou de sa vérification) : 400 s'il est mal formé. */
  parseRequest(body: unknown): BroadcastRequest {
    const invalid = (detail: string) =>
      new ProblemException(HttpStatus.BAD_REQUEST, "broadcast-invalid-request", "Diffusion invalide", detail);
    const fields = (body ?? {}) as Record<string, any>;

    const article = fields.actualite;
    const articleId = typeof article?.id === "number" ? String(article.id) : article?.id;
    if (typeof articleId !== "string" || !articleId) throw invalid("actualite.id requis (identifiant WordPress)");
    if (typeof article.url !== "string" || !/^https?:\/\//.test(article.url)) throw invalid("actualite.url requis (lien de l'Actualité)");

    const targets = fields.targets;
    if (!Array.isArray(targets) || targets.length === 0) throw invalid("targets : au moins une Ressource cible");
    for (const t of targets) {
      if (!Number.isInteger(t?.resourceId) || typeof t?.text !== "string") throw invalid("targets : { resourceId, text, format? } attendus");
      if (t.format !== undefined && typeof t.format !== "string") throw invalid("targets : format est une chaîne (post, story)");
    }
    if (new Set(targets.map((t) => t.resourceId)).size !== targets.length) throw invalid("targets : une Ressource en double");

    const images = fields.images ?? [];
    if (!Array.isArray(images)) throw invalid("images : une liste d'images décrites");
    const positive = (n: unknown) => Number.isInteger(n) && (n as number) > 0;
    for (const i of images) {
      if (typeof i?.url !== "string" || !isHttpsUrl(i.url)) throw invalid("images : url HTTPS absolue requise");
      if (typeof i.mimeType !== "string" || !positive(i.width) || !positive(i.height) || !positive(i.size)) {
        throw invalid("images : { url, mimeType, width, height, size } attendus (dimensions en pixels, poids en octets)");
      }
    }

    return {
      article: { id: articleId, url: article.url },
      targets: targets.map((t) => ({ resourceId: t.resourceId, text: t.text, format: t.format ?? "post" })),
      images: images.map((i) => ({ url: i.url, mimeType: i.mimeType.toLowerCase(), width: i.width, height: i.height, size: i.size })),
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
      const network = NETWORK_RULES[resource.type];
      const refusals: Refusal[] = [];
      if (!network) {
        refusals.push({ type: "resource-type-unsupported", detail: "Ce type de Ressource ne peut pas recevoir de Diffusion" });
      } else {
        // l'accès d'abord : sans Intégration active, inutile de parler de permissions
        if (!(await this.integrations.hasActiveAccess(resource.id, clientId, [], network.pageToken))) {
          refusals.push({ type: "integration-expired", detail: "Aucune Intégration active ne mène à cette Ressource : reconnecter le compte Meta" });
        } else if (!(await this.integrations.hasActiveAccess(resource.id, clientId, network.scopes, network.pageToken))) {
          refusals.push({
            type: "permission-missing",
            detail: `Le compte Meta n'a pas accordé la permission de publier sur ${network.label} : le reconnecter pour l'accorder`,
            requiredScopes: network.scopes,
          });
        }
        refusals.push(...contentRefusals(network, target.format, target.text, request.images));
      }
      targets.push({ resourceId: target.resourceId, refusals });
    }
    const verdict: BroadcastCheck = { ok: targets.every((t) => t.refusals.length === 0), targets };
    return { verdict, resources, clientId };
  }

  /** social.publish sur le Site est vérifié par la garde du jeton. */
  async broadcast(plugin: PluginPrincipal, request: BroadcastRequest) {
    const { verdict, resources, clientId } = await this.evaluate(plugin, request);
    if (!verdict.ok) throw broadcastRefused(verdict);

    const publications: Publication[] = [];
    for (const target of request.targets) {
      // tracée avant l'envoi : une panne pendant l'envoi laisse au moins la trace « en cours »
      const publication = await this.db.publication.create({
        data: {
          site_id: plugin.siteId,
          article_id: request.article.id,
          article_url: request.article.url,
          resource_id: target.resourceId,
          format: target.format,
          text: target.text,
          images: request.images as unknown as Prisma.InputJsonValue,
          author_id: plugin.user.id,
        },
      });
      publications.push(await this.send(publication, resources.get(target.resourceId)!, clientId));
    }
    return publications;
  }

  /**
   * Relance une Publication échouée du Site du jeton, avec le même contenu : texte, lien, format et
   * URL des images, enregistrés. Les refus prévisibles sont vérifiés comme pour une Diffusion.
   * La Publication est mise à jour, pas dupliquée.
   */
  async retry(plugin: PluginPrincipal, publicationId: number) {
    const publication = await this.db.publication.findFirst({ where: { id: publicationId, site_id: plugin.siteId } });
    if (!publication) {
      throw new ProblemException(
        HttpStatus.NOT_FOUND,
        "publication-not-found",
        "Publication introuvable",
        `Publication ${publicationId} introuvable sur ce Site`,
      );
    }
    const staleBefore = new Date(Date.now() - STALE_PENDING_MS);
    if (publication.status === "SUCCEEDED") throw publicationAlreadySucceeded();
    if (publication.status === "PENDING" && publication.attempted_at > staleBefore) throw publicationInProgress();

    const request: BroadcastRequest = {
      article: { id: publication.article_id, url: publication.article_url },
      targets: [{ resourceId: publication.resource_id, text: publication.text, format: publication.format }],
      images: imagesOf(publication),
    };
    const { verdict, resources, clientId } = await this.evaluate(plugin, request);
    if (!verdict.ok) throw broadcastRefused(verdict);

    // un seul envoi à la fois : la relance ne part que si la Publication est toujours échouée (ou interrompue)
    const { count } = await this.db.publication.updateMany({
      where: { id: publication.id, OR: [{ status: "FAILED" }, { status: "PENDING", attempted_at: { lt: staleBefore } }] },
      data: { status: "PENDING", error_type: null, error_detail: null, attempted_at: new Date() },
    });
    if (count === 0) {
      // quelqu'un est passé entre-temps : dire où en est la Publication
      const now = await this.db.publication.findUniqueOrThrow({ where: { id: publication.id } });
      throw now.status === "SUCCEEDED" ? publicationAlreadySucceeded() : publicationInProgress();
    }

    return this.send(publication, resources.get(publication.resource_id)!, clientId);
  }

  /** Les Publications d'une Actualité sur le Site du jeton, de la plus récente à la plus ancienne, avec leur Ressource. */
  history(plugin: PluginPrincipal, articleId: string) {
    return this.db.publication.findMany({
      where: { site_id: plugin.siteId, article_id: articleId },
      include: { resource: { select: { id: true, type: true, name: true } } },
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
    });
  }

  /**
   * Envoie une Publication déjà tracée et met à jour sa trace : réussie, ou échouée avec sa raison.
   * Les accès à la Ressource sont essayés l'un après l'autre : un refus d'accès (jeton refusé,
   * permission manquante) fait passer à l'Intégration suivante ; un autre échec (contenu refusé,
   * panne) est le même pour toutes, et arrête là.
   */
  private async send(publication: Publication, resource: Resource, clientId: number) {
    const network = NETWORK_RULES[resource.type]!;
    const imageUrls = imagesOf(publication).map((i) => i.url);
    try {
      const accesses = await this.integrations.activeAccesses(resource.id, clientId, network.scopes, network.pageToken);
      if (accesses.length === 0) {
        return this.fail(publication.id, "integration-expired", "Aucune Intégration active ne mène à cette Ressource");
      }
      let refused: unknown;
      for (const access of accesses) {
        try {
          const sent =
            resource.type === "INSTAGRAM_ACCOUNT"
              ? await this.meta.publishToInstagram(access.integration, resource.external_id, {
                  format: publication.format as PublicationFormat,
                  caption: publication.text, // le lien n'y serait pas cliquable : le Plugin WP le met dans le texte s'il le veut
                  imageUrls,
                })
              : await this.meta.publishToPage(access.integration, access.pageToken!, resource.external_id, {
                  message: publication.text,
                  link: publication.article_url,
                  imageUrls,
                });
          return this.db.publication.update({
            where: { id: publication.id },
            data: { status: "SUCCEEDED", network_post_id: sent.postId, network_url: sent.url, published_at: new Date() },
          });
        } catch (e) {
          const type = metaFailureType(e);
          if (type !== "integration-expired" && type !== "permission-missing") throw e;
          // Jeton de page refusé : celui de la personne l'est-il aussi ? Si oui, son Intégration expire.
          // Sinon, la page lui a été retirée : son jeton de page est oublié (la prochaine synchronisation
          // le rendra si elle la retrouve), pour qu'il ne soit plus proposé. (Instagram : c'est déjà le
          // jeton de la personne qui a été refusé, et son Intégration a été marquée expirée.)
          if (type === "integration-expired" && access.pageToken && (await this.meta.confirmUserToken(access.integration))) {
            await this.integrations.forgetPageToken(access.integration.id, resource.id);
          }
          refused = e;
        }
      }
      throw refused;
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

/** Les images enregistrées avec une Publication (leurs URL et leur description). */
function imagesOf(publication: Publication) {
  return (publication.images ?? []) as unknown as ImageRef[];
}

function isHttpsUrl(value: string) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** 422 : au moins un refus prévisible ; rien n'a été envoyé. */
function broadcastRefused(verdict: BroadcastCheck) {
  return new ProblemException(
    HttpStatus.UNPROCESSABLE_ENTITY,
    "broadcast-refused",
    "Diffusion refusée",
    "Au moins une Ressource cible refuserait cette Diffusion : rien n'a été envoyé",
    { targets: verdict.targets },
  );
}

/** 409 : la relancer la publierait une seconde fois. */
function publicationAlreadySucceeded() {
  return new ProblemException(
    HttpStatus.CONFLICT,
    "publication-already-succeeded",
    "Publication déjà réussie",
    "Cette Publication est déjà en ligne : la relancer la publierait une seconde fois",
  );
}

/** 409 : la Publication est en cours d'envoi (une relance concurrente, ou la Diffusion elle-même). */
function publicationInProgress() {
  return new ProblemException(
    HttpStatus.CONFLICT,
    "publication-in-progress",
    "Publication en cours d'envoi",
    "Cette Publication est en cours d'envoi : attendre son résultat avant de la relancer",
  );
}
