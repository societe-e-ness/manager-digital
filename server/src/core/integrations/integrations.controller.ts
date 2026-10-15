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
 *   DELETE /integrations/:id                                 → déconnecte (supprime aussi les ressources)
 *
 * Toutes exigent une session (garde globale), callback compris : Meta y renvoie le navigateur.
 * TODO droits : contrôle d'accès au client (ticket 04).
 */
@Controller("integrations")
export class IntegrationsController {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly meta: MetaService,
  ) {}

  // --- OAuth ----------------------------------------------------------------

  @Get("oauth/connect")
  connect(
    @CurrentUser() user: AuthenticatedUser,
    @Query("clientId", new ParseIntPipe({ optional: true })) clientId: number | undefined, // absent = accès de l'agence
    @Res() res: Response,
  ) {
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
  async list(@Query("clientId", new ParseIntPipe({ optional: true })) clientId: number | undefined) {
    const list = await this.integrations.list(clientId);
    return list.map((i) => this.integrations.toPublic(i));
  }

  @Get(":id")
  async get(@Param("id", ParseIntPipe) id: number) {
    return this.integrations.toPublic(await this.integrations.findById(id));
  }

  @Post(":id/resources/sync")
  async syncResources(@Param("id", ParseIntPipe) id: number) {
    const integration = await this.integrations.findById(id);
    await this.integrations.syncResources(id, await this.meta.fetchResources(integration));
    return this.integrations.toPublic(await this.integrations.findById(id));
  }

  @Patch("resources/:id")
  async attachResource(@Param("id", ParseIntPipe) id: number, @Body() body: { siteId?: number | null }) {
    if (body?.siteId === undefined) throw new BadRequestException("siteId requis (nombre, ou null pour détacher)");
    const { access_token, ...resource } = await this.integrations.attachResourceToSite(id, body.siteId);
    return resource;
  }

  @Delete(":id")
  @HttpCode(204)
  async disconnect(@Param("id", ParseIntPipe) id: number) {
    await this.integrations.disconnect(id);
  }
}
