import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  HttpCode,
  Logger,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Response } from "express";
import type { AuthenticatedUser } from "../auth/auth.service";
import { CurrentUser } from "../auth/session.guard";
import { ProblemException } from "../problems/problem.exception";
import { Features, missingFeature, RightsService } from "../rights/rights.service";
import { IntegrationsService, resourceAlreadyAttached } from "./integrations.service";
import { MetaService, metaFailureType } from "./meta.service";

/**
 * Toutes les routes du module.
 *
 *   GET    /integrations/oauth/connect?clientId=…           → envoie la personne chez Meta
 *   GET    /integrations/oauth/callback                      → Meta la renvoie avec un code ; redirige vers le front
 *                                                              (/reseaux-sociaux?clientId=…&connexion=ok ou &erreur=…)
 *   GET    /integrations?clientId=…                          → liste les intégrations (et leurs ressources)
 *   GET    /integrations/resources?clientId=…                → les ressources visibles du client
 *   GET    /integrations/:id                                 → une intégration et ses ressources
 *   POST   /integrations/:id/resources/sync                  → re-demande l'inventaire à Meta
 *   PATCH  /integrations/resources/:id                       → rattache une ressource à un site ({ siteId } ou { siteId: null })
 *   DELETE /integrations/:id                                 → déconnecte : supprime ses liens, et les ressources
 *                                                              auxquelles plus rien ne mène ni ne fait référence
 *
 * Toutes exigent une session (garde globale), callback compris : Meta y renvoie le navigateur,
 * et `social.manage` sur au moins un Site du Client concerné. Un accès de l'agence (sans Client),
 * comme la liste de tous les Clients, est réservé aux Utilisateurs agence. En plus :
 *  - rattacher : social.manage sur le Site visé, et la Ressource doit être atteinte par une Intégration
 *    du Client de ce Site (ou de l'agence, pour un Utilisateur agence) ; une Ressource rattachée
 *    ailleurs doit d'abord être détachée (409) ;
 *  - détacher : social.manage sur le Site actuel ;
 *  - déconnecter : sa propre Intégration, ou n'importe laquelle pour un Utilisateur agence.
 * Une Ressource rattachée au Site d'un Client que l'utilisateur ne voit pas n'en montre pas le Site.
 */
@Controller("integrations")
export class IntegrationsController {
  private readonly logger = new Logger(IntegrationsController.name);

  constructor(
    private readonly integrations: IntegrationsService,
    private readonly meta: MetaService,
    private readonly rights: RightsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * social.manage sur au moins un Site du Client. Sans Client (accès de l'agence, ou tous les Clients) :
   * sur n'importe quel Site, et réservé aux Utilisateurs agence.
   */
  private async requireManage(user: AuthenticatedUser, clientId: number | null | undefined) {
    await this.rights.requireFeature(user, Features.SOCIAL_MANAGE, { clientId: clientId ?? undefined });
    if (clientId == null && user.type !== "AGENCY") {
      throw new ProblemException(
        HttpStatus.FORBIDDEN,
        "agency-only",
        "Réservé à l'agence",
        "Les accès de l'agence ne se gèrent que par un Utilisateur agence : préciser le Client (clientId)",
      );
    }
  }

  /** requireManage pour au moins un de ces Clients ; sinon, l'erreur du dernier essai. */
  private async requireManageAny(user: AuthenticatedUser, clientIds: (number | null)[]) {
    let denied: unknown = missingFeature(Features.SOCIAL_MANAGE);
    for (const clientId of new Set(clientIds)) {
      try {
        return await this.requireManage(user, clientId);
      } catch (e) {
        denied = e;
      }
    }
    throw denied;
  }

  // --- OAuth ----------------------------------------------------------------

  @Get("oauth/connect")
  async connect(
    @CurrentUser() user: AuthenticatedUser,
    @Query("clientId", new ParseIntPipe({ optional: true })) clientId: number | undefined, // absent = accès de l'agence
    @Res() res: Response,
  ) {
    await this.requireManage(user, clientId);
    const state = this.meta.signState({ userId: user.id, clientId: clientId ?? null });
    return res.redirect(this.meta.buildAuthorizationUrl(state));
  }

  /**
   * Meta renvoie ici le navigateur. On le ramène toujours vers la page de gestion du front :
   * `/reseaux-sociaux?clientId=…&connexion=ok`, ou `&erreur=<type>` en cas d'échec.
   */
  @Get("oauth/callback")
  async callback(
    @CurrentUser() user: AuthenticatedUser,
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Query("error") error: string | undefined,
    @Res() res: Response,
  ) {
    const back = new URL("/reseaux-sociaux", this.config.getOrThrow<string>("CLIENT_PUBLIC_URL"));
    let clientId: number | null = null;
    try {
      const verified = this.meta.verifyState(state);
      // le Client d'un state lancé par quelqu'un d'autre ne doit pas finir dans l'URL de la victime
      if (verified.userId === user.id) clientId = verified.clientId;
      await this.completeConnection(user, verified, code, error);
      back.searchParams.set("connexion", "ok");
    } catch (e) {
      back.searchParams.set("erreur", this.callbackErrorType(e));
    }
    if (clientId !== null) back.searchParams.set("clientId", String(clientId));
    res.redirect(back.href);
  }

  private async completeConnection(
    user: AuthenticatedUser,
    { userId, clientId }: { userId: number; clientId: number | null },
    code: string | undefined,
    error: string | undefined,
  ) {
    // Le state signé dit qui a lancé la connexion et pour quel client. On vérifie en plus
    // que c'est bien cette personne qui revient : sinon un state volé permettrait de faire
    // rattacher le compte Meta d'une victime à la session d'un attaquant.
    if (userId !== user.id) {
      throw new ProblemException(
        HttpStatus.FORBIDDEN,
        "oauth-state-mismatch",
        "Connexion Meta lancée par quelqu'un d'autre",
        "Relancer la connexion Meta depuis votre propre session",
      );
    }

    if (error || !code) {
      // La personne a refusé le consentement, ou Meta a échoué.
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        "meta-consent-refused",
        "Connexion Meta refusée",
        `Connexion Meta refusée : ${error ?? "code manquant"}`,
      );
    }

    // Le droit a pu être retiré depuis le départ chez Meta : on le revérifie avant tout appel.
    await this.requireManage(user, clientId);

    // 1. code → jeton de 60 jours
    const token = await this.meta.exchangeCode(code);
    // 2. qui est-ce, et quelles permissions a-t-elle accordées
    const identity = await this.meta.fetchIdentity(token.accessToken);
    // 3. la clé : créée, ou mise à jour si cette personne s'était déjà connectée pour ce Client
    const integration = await this.integrations.upsertFromOAuth({
      externalUserId: identity.externalUserId,
      accessToken: token.accessToken,
      expiresAt: token.expiresAt,
      scopes: identity.scopes,
      clientId,
      createdById: userId,
    });
    // 4. les portes : pages, comptes Instagram, comptes publicitaires
    await this.integrations.syncResources(integration.id, await this.meta.fetchResources(integration));
  }

  /** Le `type` d'erreur transmis au front après un retour de Meta raté. */
  private callbackErrorType(e: unknown) {
    if (e instanceof ProblemException) return e.type;
    if (e instanceof UnauthorizedException) return "oauth-state-invalid"; // state forgé ou périmé
    this.logger.error(`Connexion Meta impossible : ${e instanceof Error ? e.stack : String(e)}`);
    const meta = metaFailureType(e);
    if (meta === "network-unavailable") return "meta-unavailable"; // panne ou limite de Meta : réessayer plus tard
    return meta ? "meta-connection-failed" : "internal-error"; // Meta a refusé, ou erreur chez nous
  }

  // --- Gestion des connexions ----------------------------------------------

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query("clientId", new ParseIntPipe({ optional: true })) clientId: number | undefined,
  ) {
    await this.requireManage(user, clientId);
    const [list, visible] = await Promise.all([this.integrations.list(clientId), this.rights.visibleClients(user)]);
    return list.map((i) => this.integrations.toPublic(i, visible));
  }

  // Déclarée avant ":id", qui l'attraperait sinon.
  @Get("resources")
  async listResources(
    @CurrentUser() user: AuthenticatedUser,
    @Query("clientId", new ParseIntPipe({ optional: true })) clientId: number | undefined, // absent = tous (agence)
  ) {
    await this.requireManage(user, clientId);
    const [list, visible] = await Promise.all([this.integrations.listResources(clientId), this.rights.visibleClients(user)]);
    return list.map((r) => this.integrations.toPublicResource(r, visible));
  }

  @Get(":id")
  async get(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseIntPipe) id: number) {
    const integration = await this.integrations.findById(id);
    await this.requireManage(user, integration.client_id);
    return this.integrations.toPublic(integration, await this.rights.visibleClients(user));
  }

  @Post(":id/resources/sync")
  async syncResources(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseIntPipe) id: number) {
    const integration = await this.integrations.findById(id);
    await this.requireManage(user, integration.client_id);
    await this.integrations.syncResources(id, await this.meta.fetchResources(integration));
    return this.integrations.toPublic(await this.integrations.findById(id), await this.rights.visibleClients(user));
  }

  @Patch("resources/:id")
  async attachResource(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: { siteId?: unknown },
  ) {
    const target = body?.siteId;
    if (target !== null && (typeof target !== "number" || !Number.isInteger(target))) {
      throw new BadRequestException("siteId requis (nombre, ou null pour détacher)");
    }
    const current = await this.integrations.findResourceById(id);
    const reachedBy = current.integrations.map((l) => l.integration.client_id);

    if (target === null) {
      // Détacher : droit sur le Site actuel (rien à faire si elle n'en a pas, mais il faut pouvoir la gérer).
      if (current.site_id !== null) await this.rights.requireFeature(user, Features.SOCIAL_MANAGE, { siteId: current.site_id });
      else await this.requireManageAny(user, reachedBy);
    } else {
      await this.rights.requireFeature(user, Features.SOCIAL_MANAGE, { siteId: target });
      if (current.site_id !== null && current.site_id !== target) throw resourceAlreadyAttached();
      if (current.site_id === null) {
        // Pas de Ressource prise à un autre Client : le Site publiera au travers de ces Intégrations.
        const siteClientId = await this.integrations.siteClientId(target);
        const reachable = reachedBy.some((clientId) => clientId === siteClientId || (clientId === null && user.type === "AGENCY"));
        if (!reachable) {
          throw new ProblemException(
            HttpStatus.FORBIDDEN,
            "resource-not-reachable",
            "Ressource hors de portée",
            "Aucune Intégration de ce Client ne mène à cette Ressource : connecter d'abord un compte qui y a accès",
          );
        }
      }
    }

    const [resource, visible] = await Promise.all([
      this.integrations.attachResourceToSite(id, target, current.site_id),
      this.rights.visibleClients(user),
    ]);
    return this.integrations.toPublicResource(resource, visible);
  }

  @Delete(":id")
  @HttpCode(204)
  async disconnect(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseIntPipe) id: number) {
    const integration = await this.integrations.findById(id);
    await this.requireManage(user, integration.client_id);
    // On ne déconnecte que ses propres Intégrations ; l'agence peut tout déconnecter.
    if (user.type !== "AGENCY" && integration.created_by_id !== user.id) {
      throw new ProblemException(
        HttpStatus.FORBIDDEN,
        "not-integration-owner",
        "Intégration d'une autre personne",
        "Seule la personne qui a connecté ce compte, ou l'agence, peut le déconnecter",
      );
    }
    await this.integrations.disconnect(id);
  }
}
