import { Body, Controller, Delete, Get, Header, HttpCode, Param, ParseIntPipe, Post, Query, Req, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request, Response } from "express";
import { AuthService, type AuthenticatedUser } from "../auth/auth.service";
import { readSessionCookie } from "../auth/session-cookie";
import { CurrentUser, Public } from "../auth/session.guard";
import { PluginAuthService } from "./plugin-auth.service";

/**
 * Serveur d'autorisation du Plugin WP (ADR 0002).
 *
 *   GET    /oauth/authorize?response_type=code&client_id=wp-plugin&redirect_uri=…
 *                          &code_challenge=…&code_challenge_method=S256&state=…
 *                                   → valide, puis envoie vers le front : /autoriser (connecté)
 *                                     ou /connexion?returnTo=/autoriser?… (non connecté)
 *   GET    /oauth/consent?…          → (session) les Sites que l'utilisateur peut autoriser
 *   POST   /oauth/consent            → (session) { …mêmes paramètres, decision: "allow" | "deny", siteId }
 *                                     → { redirectTo } : retour vers le Plugin WP, avec code ou erreur
 *   POST   /oauth/token              → (Plugin WP, serveur à serveur) code + code_verifier → jeton Bearer
 *   POST   /oauth/revoke             → (Plugin WP) RFC 7009 : révoque son jeton
 *   GET    /oauth/authorizations     → (session) les autorisations actives : les siennes, toutes pour l'agence
 *   DELETE /oauth/authorizations/:id → (session) révoque : la sienne, n'importe laquelle pour l'agence
 */
@Controller("oauth")
export class PluginAuthController {
  constructor(
    private readonly pluginAuth: PluginAuthService,
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Get("authorize")
  async authorize(@Query() query: Record<string, unknown>, @Req() req: Request, @Res() res: Response) {
    await this.pluginAuth.validateAuthorizeRequest(query);

    // la page d'autorisation du front reprend la demande telle quelle
    const consentPath = `/autoriser?${req.originalUrl.split("?")[1] ?? ""}`;
    const front = this.config.getOrThrow<string>("CLIENT_PUBLIC_URL");
    const sessionToken = readSessionCookie(req);
    const session = sessionToken ? await this.auth.resolveSession(sessionToken) : null;
    if (session) return res.redirect(`${front}${consentPath}`);

    const login = new URL("/connexion", front);
    login.searchParams.set("returnTo", consentPath);
    res.redirect(login.href);
  }

  @Get("consent")
  async consentContext(@CurrentUser() user: AuthenticatedUser, @Query() query: Record<string, unknown>) {
    const request = await this.pluginAuth.validateAuthorizeRequest(query);
    return {
      client: "Plugin WP",
      redirectHost: new URL(request.redirectUri).host,
      sites: await this.pluginAuth.authorizableSites(user, request.redirectUri),
    };
  }

  @Post("consent")
  @HttpCode(200)
  async consent(@CurrentUser() user: AuthenticatedUser, @Body() body: Record<string, unknown>) {
    const request = await this.pluginAuth.validateAuthorizeRequest(body ?? {});
    const redirectTo =
      body.decision === "allow" ? await this.pluginAuth.approve(user, request, body.siteId) : this.pluginAuth.deny(request);
    return { redirectTo };
  }

  @Public()
  @Post("token")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  token(@Body() body: Record<string, unknown>) {
    return this.pluginAuth.exchangeCode(body ?? {});
  }

  @Public()
  @Post("revoke")
  @HttpCode(200)
  async revoke(@Body() body: { token?: unknown }) {
    await this.pluginAuth.revokeToken(body?.token);
  }

  @Get("authorizations")
  authorizations(@CurrentUser() user: AuthenticatedUser) {
    return this.pluginAuth.listAuthorizations(user);
  }

  @Delete("authorizations/:id")
  @HttpCode(204)
  async revokeAuthorization(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseIntPipe) id: number) {
    await this.pluginAuth.revokeAuthorization(user, id);
  }
}
