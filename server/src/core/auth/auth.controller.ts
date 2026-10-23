import { BadRequestException, Body, Controller, Get, HttpCode, Logger, Post, Req, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request, Response } from "express";
import { AuthService, type AuthenticatedUser } from "./auth.service";
import { clearSessionCookie, readSessionCookie, setSessionCookie } from "./session-cookie";
import { CurrentUser, Public } from "./session.guard";
import { SsoService } from "./sso.service";

/**
 *   POST /auth/magic-link         { email, returnTo? } → envoie un lien si l'email est connu (toujours 204) ;
 *                                           le lien garde `returnTo` (chemin local) pour y revenir ensuite
 *   POST /auth/magic-link/verify  { token } → ouvre une session, pose le cookie
 *   GET  /auth/me                           → l'utilisateur connecté
 *   POST /auth/logout                       → révoque la session, efface le cookie ;
 *                                             pour une session SSO : 200 { logoutUrl } vers auth.eness
 *
 * La validation passe par un POST, pas par un GET sur le lien : les antivirus de
 * messagerie ouvrent les liens des mails et consommeraient le jeton à usage unique.
 * Le lien mène donc au front, qui envoie le jeton ici.
 */
@Controller("auth")
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
    private readonly sso: SsoService,
  ) {}

  @Public()
  @Post("magic-link")
  @HttpCode(204)
  async requestMagicLink(@Body() body: { email?: unknown; returnTo?: unknown }) {
    if (typeof body?.email !== "string" || !body.email.trim()) throw new BadRequestException("email requis");
    await this.auth.requestMagicLink(body.email, body.returnTo);
  }

  @Public()
  @Post("magic-link/verify")
  @HttpCode(200)
  async verifyMagicLink(
    @Body() body: { token?: unknown },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthenticatedUser> {
    if (typeof body?.token !== "string" || !body.token) throw new BadRequestException("token requis");
    const { sessionToken, expiresAt, user } = await this.auth.verifyMagicLink(body.token, req.headers["user-agent"]);
    setSessionCookie(res, this.config, sessionToken, expiresAt);
    return user;
  }

  @Get("me")
  me(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }

  // publique : se déconnecter sans session valide ne fait rien, mais efface quand même le cookie
  @Public()
  @Post("logout")
  async logout(@Req() req: Request, @Res() res: Response) {
    const token = readSessionCookie(req);
    const session = token ? await this.auth.revokeSession(token) : null;
    clearSessionCookie(res, this.config);

    // session SSO : le front redirige vers auth.eness, qui propose de quitter
    // seulement le Manager Digital ou tous les services eness
    if (session?.method === "SSO" && session.id_token && this.sso.enabled) {
      try {
        res.status(200).json({ logoutUrl: await this.sso.endSessionUrl(session.id_token) });
        return;
      } catch (e) {
        // auth.eness injoignable : la session locale est fermée, c'est l'essentiel
        this.logger.warn(`URL de déconnexion auth.eness indisponible : ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    res.status(204).end();
  }
}
