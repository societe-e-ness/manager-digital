import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import type { Publication, Resource } from "../../generated/prisma/client";
import { DatabaseService } from "../database/database.service";
import { IntegrationsService } from "../integrations/integrations.service";
import { MetaService, metaFailureType } from "../integrations/meta.service";
import type { PluginPrincipal } from "../plugin-auth/plugin-auth.service";
import { ProblemException } from "../problems/problem.exception";
import { contentRefusals, NETWORK_RULES, type Refusal } from "./broadcast-rules";

// une Publication « en cours » depuis plus longtemps a été interrompue (coupure pendant l'envoi) :
// elle peut être relancée. Bien au-delà de la durée maximale d'une requête.
const STALE_PENDING_MS = 15 * 60 * 1000;

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
    if (!verdict.ok) throw broadcastRefused(verdict);

    const publications: Publication[] = [];
    for (const target of request.targets) {
      const resource = resources.get(target.resourceId)!;
      // tracée avant l'envoi : une panne pendant l'envoi laisse au moins la trace « en cours »
      const publication = await this.db.publication.create({
        data: {
          site_id: plugin.siteId,
          article_id: request.article.id,
          article_url: request.article.url,
          resource_id: target.resourceId,
          text: target.text,
          image_count: request.images.length,
          author_id: plugin.user.id,
        },
      });
      publications.push(await this.send(publication, resource, clientId, request.images));
    }
    return publications;
  }

  /**
   * Relance une Publication échouée du Site du jeton : même texte, même lien, et les images que
   * le Plugin WP joint de nouveau (elles ne sont pas conservées). Les refus prévisibles sont
   * vérifiés comme pour une Diffusion. La Publication est mise à jour, pas dupliquée.
   */
  async retry(plugin: PluginPrincipal, publicationId: number, images: UploadedImage[]) {
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
    if (images.length !== publication.image_count) {
      throw new ProblemException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        "retry-images-mismatch",
        "Images à joindre de nouveau",
        `Cette Publication a été diffusée avec ${publication.image_count} image(s) : les joindre de nouveau (elles ne sont pas conservées)`,
        { imageCount: publication.image_count },
      );
    }

    const request: BroadcastRequest = {
      article: { id: publication.article_id, url: publication.article_url },
      targets: [{ resourceId: publication.resource_id, text: publication.text }],
      images,
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

    return this.send(publication, resources.get(publication.resource_id)!, clientId, images);
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
   * Les accès à la page sont essayés l'un après l'autre : un refus d'accès (jeton refusé, permission
   * manquante) fait passer à l'Intégration suivante ; un autre échec (contenu refusé, panne) est
   * le même pour toutes, et arrête là.
   */
  private async send(publication: Publication, resource: Resource, clientId: number, images: UploadedImage[]) {
    const post = {
      message: publication.text,
      link: publication.article_url,
      images: images.map((i) => ({ buffer: i.buffer, mimetype: i.mimetype, filename: i.originalname })),
    };
    try {
      const accesses = await this.integrations.activeAccesses(resource.id, clientId, NETWORK_RULES[resource.type]!.scopes);
      if (accesses.length === 0) {
        return this.fail(publication.id, "integration-expired", "Aucune Intégration active ne mène à cette Ressource");
      }
      let refused: unknown;
      for (const access of accesses) {
        try {
          const sent = await this.meta.publishToPage(access.integration, access.pageToken, resource.external_id, post);
          return this.db.publication.update({
            where: { id: publication.id },
            data: { status: "SUCCEEDED", network_post_id: sent.postId, network_url: sent.url, published_at: new Date() },
          });
        } catch (e) {
          const type = metaFailureType(e);
          if (type !== "integration-expired" && type !== "permission-missing") throw e;
          // Jeton de page refusé : celui de la personne l'est-il aussi ? Si oui, son Intégration expire.
          // Sinon, la page lui a été retirée : son jeton de page est oublié (la prochaine synchronisation
          // le rendra si elle la retrouve), pour qu'il ne soit plus proposé.
          if (type === "integration-expired" && (await this.meta.confirmUserToken(access.integration))) {
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
