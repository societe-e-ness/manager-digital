import { Body, Controller, Get, Header, HttpCode, HttpStatus, Post, Query, Req, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request, Response } from "express";
import { ProblemException } from "../problems/problem.exception";
import { AuthService } from "./auth.service";
import { clearSsoFlowCookie, readSsoFlowCookie, setSessionCookie, setSsoFlowCookie } from "./session-cookie";
import { Public } from "./session.guard";
import { SsoService } from "./sso.service";

/**
 * Connexion par le SSO auth.eness (OpenID Connect).
 *
 *   GET  /auth/sso/login?returnTo=/chemin  → redirige vers auth.eness
 *   GET  /auth/sso/callback                → auth.eness y renvoie le navigateur ; ouvre la session
 *   POST /auth/sso/backchannel             → auth.eness signale une déconnexion faite ailleurs
 *
 * URL à déclarer dans auth : {APP_PUBLIC_URL}/auth/sso/callback et /auth/sso/backchannel.
 */
@Public()
@Controller("auth/sso")
export class SsoController {
  constructor(
    private readonly sso: SsoService,
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Get("login")
  async login(@Query("returnTo") returnTo: unknown, @Res() res: Response) {
    const { url, flow, maxAgeMs } = await this.sso.startLogin(returnTo);
    setSsoFlowCookie(res, this.config, flow, maxAgeMs);
    res.redirect(url);
  }

  /**
   * Le navigateur arrive ici : en cas d'échec, on le renvoie vers la page de connexion
   * du front avec le `type` de l'erreur, plutôt que d'afficher du JSON brut.
   */
  @Get("callback")
  async callback(@Req() req: Request, @Res() res: Response) {
    try {
      await this.completeCallback(req, res);
    } catch (e) {
      if (!(e instanceof ProblemException)) throw e;
      const url = new URL("/connexion", this.config.getOrThrow<string>("CLIENT_PUBLIC_URL"));
      url.searchParams.set("erreur", e.type);
      res.redirect(url.href);
    }
  }

  private async completeCallback(req: Request, res: Response) {
    const flow = this.sso.readFlow(readSsoFlowCookie(req));
    clearSsoFlowCookie(res, this.config);
    if (!flow) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        "sso-flow-missing",
        "Connexion SSO non commencée ou expirée",
        "Aucune connexion SSO en cours dans ce navigateur : recommencer depuis le Manager Digital",
      );
    }

    // l'URL publique, pas celle vue derrière un proxy (où le protocole peut valoir http)
    const currentUrl = new URL(req.originalUrl, this.config.getOrThrow<string>("APP_PUBLIC_URL"));
    const identity = await this.sso.completeLogin(currentUrl, flow);
    const { sessionToken, expiresAt } = await this.auth.loginWithSso(identity, req.headers["user-agent"]);

    setSessionCookie(res, this.config, sessionToken, expiresAt);
    res.redirect(`${this.config.getOrThrow<string>("CLIENT_PUBLIC_URL")}${flow.returnTo}`);
  }

  @Post("backchannel")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async backchannel(@Body() body: { logout_token?: unknown }) {
    await this.auth.revokeSsoSessions(await this.sso.verifyLogoutToken(body?.logout_token));
  }
}
