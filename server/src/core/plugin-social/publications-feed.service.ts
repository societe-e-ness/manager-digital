import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import type { Resource } from "../../generated/prisma/client";
import { IntegrationsService } from "../integrations/integrations.service";
import { MetaService, metaFailureType, type NetworkPost } from "../integrations/meta.service";
import type { PluginPrincipal } from "../plugin-auth/plugin-auth.service";
import { ProblemException } from "../problems/problem.exception";

const CACHE_TTL_MS = 5 * 60 * 1000;
// une fenêtre de Publications récentes par Ressource : la liste fusionnée est paginée dans cette fenêtre
const RECENT_PER_RESOURCE = 50;
const READABLE = new Set(["FACEBOOK_PAGE", "INSTAGRAM_ACCOUNT"]);

export type FeedPublication = NetworkPost & { resourceId: number };
type ReadResult = { posts: FeedPublication[] } | { resourceId: number; type: string };

// quand aucune Ressource n'a pu être lue : statut HTTP et explication, selon la raison
// (une permission Meta manquante se règle aussi en reconnectant : 409, pas le 403 du droit manquant)
const FAILURES: Record<string, { status: HttpStatus; detail: string }> = {
  "integration-expired": {
    status: HttpStatus.CONFLICT,
    detail: "Aucune Intégration active ne mène à ces Ressources : reconnecter le compte Meta",
  },
  "permission-missing": {
    status: HttpStatus.CONFLICT,
    detail: "Le compte Meta n'a pas accordé la permission de lecture : le reconnecter pour l'accorder",
  },
  "internal-error": { status: HttpStatus.INTERNAL_SERVER_ERROR, detail: "Erreur interne du Manager Digital" },
};

/**
 * Les Publications des Ressources d'un Site, lues à la volée chez Meta (rien n'est stocké),
 * avec un cache en mémoire de quelques minutes par Ressource.
 */
@Injectable()
export class PublicationsFeedService {
  private readonly logger = new Logger(PublicationsFeedService.name);
  private readonly cache = new Map<number, { expiresAt: number; posts: FeedPublication[] }>();

  constructor(
    private readonly integrations: IntegrationsService,
    private readonly meta: MetaService,
  ) {}

  /** Pour les tests : l'application de test survit d'un test à l'autre, pas les données. */
  clearCache() {
    this.cache.clear();
  }

  async list(plugin: PluginPrincipal, query: { page: number; limit: number; resourceId?: number }) {
    for (const [id, entry] of this.cache) if (entry.expiresAt <= Date.now()) this.cache.delete(id);

    let resources = (await this.integrations.listSiteResources(plugin.siteId)).filter((r) => READABLE.has(r.type));
    if (query.resourceId !== undefined) {
      resources = resources.filter((r) => r.id === query.resourceId);
      if (resources.length === 0) {
        throw new ProblemException(
          HttpStatus.UNPROCESSABLE_ENTITY,
          "resource-not-attached",
          "Ressource non rattachée au Site",
          "Seules les pages Facebook et comptes Instagram rattachés au Site du Plugin WP se consultent",
          { resourceIds: [query.resourceId] },
        );
      }
    }

    const clientId = await this.integrations.siteClientId(plugin.siteId);
    const results = await Promise.all(resources.map((r) => this.read(r, clientId)));
    const unavailable = results.filter((r): r is { resourceId: number; type: string } => "type" in r);

    // rien n'a pu être lu : une erreur explicite plutôt qu'une liste vide trompeuse
    if (resources.length > 0 && unavailable.length === resources.length) {
      const type = unavailable[0].type;
      const failure = FAILURES[type] ?? { status: HttpStatus.BAD_GATEWAY, detail: "Impossible de lire les Publications chez Meta pour le moment" };
      // la raison de chaque Ressource : elles peuvent différer
      throw new ProblemException(failure.status, type, "Publications indisponibles", failure.detail, {
        resourceIds: unavailable.map((u) => u.resourceId),
        unavailable,
      });
    }

    const all = results
      .flatMap((r) => ("posts" in r ? r.posts : []))
      .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
    const start = (query.page - 1) * query.limit;
    return {
      publications: all.slice(start, start + query.limit),
      page: query.page,
      limit: query.limit,
      hasMore: start + query.limit < all.length,
      unavailable,
    };
  }

  private async read(resource: Resource, clientId: number): Promise<ReadResult> {
    try {
      // l'accès est vérifié avant le cache : une page détachée, ou dont l'accès a été retiré, n'est plus servie
      const reader = await this.reader(resource, clientId);
      if (!reader) return { resourceId: resource.id, type: "integration-expired" };

      const cached = this.cache.get(resource.id);
      if (cached && cached.expiresAt > Date.now()) return { posts: cached.posts };

      const posts = await reader();
      const withResource = posts.map((p) => ({ ...p, resourceId: resource.id }));
      this.cache.set(resource.id, { expiresAt: Date.now() + CACHE_TTL_MS, posts: withResource });
      return { posts: withResource };
    } catch (e) {
      const type = metaFailureType(e);
      if (!type) this.logger.error(`Lecture des Publications de la Ressource ${resource.id} : ${e instanceof Error ? e.stack : String(e)}`);
      return { resourceId: resource.id, type: type ?? "internal-error" };
    }
  }

  /** De quoi lire les Publications chez Meta, ou null si aucune Intégration active du Client n'y mène. */
  private async reader(resource: Resource, clientId: number): Promise<(() => Promise<NetworkPost[]>) | null> {
    if (resource.type === "FACEBOOK_PAGE") {
      const access = await this.integrations.activeAccess(resource.id, clientId);
      return access && (() => this.meta.fetchPagePosts(access.integration, access.pageToken, resource.external_id, RECENT_PER_RESOURCE));
    }
    const integration = await this.integrations.activeIntegration(resource.id, clientId);
    return integration && (() => this.meta.fetchInstagramMedia(integration, resource.external_id, RECENT_PER_RESOURCE));
  }
}
