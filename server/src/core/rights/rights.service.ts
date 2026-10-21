import { HttpStatus, Injectable } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.service";
import { DatabaseService } from "../database/database.service";
import { ProblemException } from "../problems/problem.exception";

/** Les Fonctionnalités utilisées dans le code (slugs de la table `feature`, voir le seed). */
export const Features = {
  SOCIAL_READ: "social.read", // lister les Publications
  SOCIAL_PUBLISH: "social.publish", // diffuser une Actualité
  SOCIAL_MANAGE: "social.manage", // connecter un compte Meta, rattacher ou détacher une Ressource
} as const;

/** Où chercher le droit. Rien = sur au moins un des Sites accessibles à l'utilisateur. */
export interface RightsScope {
  siteId?: number;
  clientId?: number;
}

/**
 * Calcul des droits d'un utilisateur sur un Site. Il a une Fonctionnalité sur un Site si :
 *  - il appartient au Client du Site (un Utilisateur agence appartient à tous les Clients) ;
 *  - le Site l'autorise (site_feature : le plafond, qui a le dernier mot) ;
 *  - aucune surcharge REMOVE, sur ce Site ou sur tous ses Sites, ne la lui retire ;
 *  - un pack ou une surcharge ADD la lui donne, sur ce Site ou sur tous ses Sites.
 */
@Injectable()
export class RightsService {
  constructor(private readonly db: DatabaseService) {}

  /** Les Sites (dans la portée) sur lesquels l'utilisateur a la Fonctionnalité. Trois requêtes, quel que soit le nombre de Sites. */
  async sitesWithFeature(user: AuthenticatedUser, slug: string, scope: RightsScope = {}): Promise<number[]> {
    const sites = await this.db.site.findMany({
      where: {
        id: scope.siteId,
        client_id: scope.clientId,
        features: { some: { feature: { slug } } },
        ...(user.type === "AGENCY" ? {} : { client: { users: { some: { user_id: user.id } } } }),
      },
      select: { id: true },
    });
    if (sites.length === 0) return [];

    const [overrides, packs] = await Promise.all([
      this.db.userFeature.findMany({ where: { user_id: user.id, feature: { slug } }, select: { site_id: true, effect: true } }),
      this.db.userPack.findMany({
        where: { user_id: user.id, pack: { features: { some: { feature: { slug } } } } },
        select: { site_id: true },
      }),
    ]);

    return sites
      .map((s) => s.id)
      .filter((siteId) => {
        // site_id null = valable sur tous les Sites
        const appliesHere = (grant: { site_id: number | null }) => grant.site_id === null || grant.site_id === siteId;
        if (overrides.some((o) => o.effect === "REMOVE" && appliesHere(o))) return false;
        return overrides.some((o) => o.effect === "ADD" && appliesHere(o)) || packs.some(appliesHere);
      });
  }

  async hasFeature(user: AuthenticatedUser, slug: string, scope: RightsScope = {}) {
    return (await this.sitesWithFeature(user, slug, scope)).length > 0;
  }

  /** 403 Problem Details (`missing-feature`) si l'utilisateur n'a la Fonctionnalité sur aucun Site de la portée. */
  async requireFeature(user: AuthenticatedUser, slug: string, scope: RightsScope = {}) {
    if (!(await this.hasFeature(user, slug, scope))) throw missingFeature(slug);
  }
}

/** L'erreur « droit manquant » : 403 Problem Details au type stable `missing-feature`. */
export function missingFeature(slug: string) {
  return new ProblemException(HttpStatus.FORBIDDEN, "missing-feature", "Droit manquant", `Fonctionnalité ${slug} requise`, {
    feature: slug,
  });
}
