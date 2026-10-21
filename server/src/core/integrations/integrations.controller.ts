import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import type { AuthenticatedUser } from "../auth/auth.service";
import { CurrentUser } from "../auth/session.guard";
import { ProblemException } from "../problems/problem.exception";
import { Features, missingFeature, RightsService } from "../rights/rights.service";
import { IntegrationsService } from "./integrations.service";
import { MetaService } from "./meta.service";

/**
 * Toutes les routes du module.
 *
 *   GET    /integrations/oauth/connect?clientId=…           → envoie la personne chez Meta
 *   GET    /integrations/oauth/callback                      → Meta la renvoie avec un code
 *   GET    /integrations?clientId=…                          → liste les intégrations (et leurs ressources)
 *   GET    /integrations/:id                                 → une intégration et ses ressources
 *   POST   /integrations/:id/resources/sync                  → re-demande l'inventaire à Meta
 *   PATCH  /integrations/resources/:id                       → rattache une ressource à un site ({ siteId } ou { siteId: null })
 *   DELETE /integrations/:id                                 → déconnecte : supprime ses liens, et les ressources
 *                                                              auxquelles plus rien ne mène ni ne fait référence
 *
 * Toutes exigent une session (garde globale), callback compris : Meta y renvoie le navigateur,
 * et `social.manage` : sur le Site visé et sur le Site actuel de la Ressource pour un rattachement
 * ou un détachement, sinon sur au moins un Site du Client concerné. Un accès de l'agence
 * (sans Client), comme la liste de tous les Clients, est réservé aux Utilisateurs agence.
 */
@Controller("integrations")
export class IntegrationsController {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly meta: MetaService,
    private readonly rights: RightsService,
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

  @Get("oauth/callback")
  async callback(
    @CurrentUser() user: AuthenticatedUser,
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Query("error") error: string | undefined,
  ) {
    // Le state signé dit qui a lancé la connexion et pour quel client. On vérifie en plus
    // que c'est bien cette personne qui revient : sinon un state volé permettrait de faire
    // rattacher le compte Meta d'une victime à la session d'un attaquant.
    const { userId, clientId } = this.meta.verifyState(state);
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
      throw new BadRequestException(`Connexion Meta refusée : ${error ?? "code manquant"}`);
    }

    // Le droit a pu être retiré depuis le départ chez Meta : on le revérifie avant tout appel.
    await this.requireManage(user, clientId);

    // 1. code → jeton de 60 jours
    const token = await this.meta.exchangeCode(code);
    // 2. qui est-ce, et quelles permissions a-t-elle accordées
    const identity = await this.meta.fetchIdentity(token.accessToken);
    // 3. la clé : créée, ou mise à jour si cette personne s'était déjà connectée
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

    // TODO front : remplacer par une redirection vers la page des intégrations.
    // Étape suivante : PATCH /integrations/resources/:id { siteId } pour rattacher une ressource à un site.
    return this.integrations.toPublic(await this.integrations.findById(integration.id));
  }

  // --- Gestion des connexions ----------------------------------------------

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query("clientId", new ParseIntPipe({ optional: true })) clientId: number | undefined,
  ) {
    await this.requireManage(user, clientId);
    const list = await this.integrations.list(clientId);
    return list.map((i) => this.integrations.toPublic(i));
  }

  @Get(":id")
  async get(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseIntPipe) id: number) {
    const integration = await this.integrations.findById(id);
    await this.requireManage(user, integration.client_id);
    return this.integrations.toPublic(integration);
  }

  @Post(":id/resources/sync")
  async syncResources(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseIntPipe) id: number) {
    const integration = await this.integrations.findById(id);
    await this.requireManage(user, integration.client_id);
    await this.integrations.syncResources(id, await this.meta.fetchResources(integration));
    return this.integrations.toPublic(await this.integrations.findById(id));
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
    // Droit sur le Site visé et sur le Site actuel : on ne prend pas la Ressource d'un autre Site.
    const current = await this.integrations.findResourceById(id);
    const sites = [...new Set([target, current.site_id])].filter((siteId) => siteId !== null);
    for (const siteId of sites) await this.rights.requireFeature(user, Features.SOCIAL_MANAGE, { siteId });
    // Ni rattachée ni à rattacher : il faut pouvoir gérer une des Intégrations qui y mènent.
    if (sites.length === 0) await this.requireManageAny(user, current.integrations.map((l) => l.integration.client_id));
    return this.integrations.toPublicResource(await this.integrations.attachResourceToSite(id, target));
  }

  @Delete(":id")
  @HttpCode(204)
  async disconnect(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseIntPipe) id: number) {
    await this.requireManage(user, (await this.integrations.findById(id)).client_id);
    await this.integrations.disconnect(id);
  }
}
