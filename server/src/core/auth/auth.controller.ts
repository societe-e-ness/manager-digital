import { BadRequestException, Body, Controller, Get, HttpCode, Post, Req, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request, Response } from "express";
import { AuthService, type AuthenticatedUser } from "./auth.service";
import { clearSessionCookie, readSessionCookie, setSessionCookie } from "./session-cookie";
import { CurrentUser, Public } from "./session.guard";

/**
 *   POST /auth/magic-link         { email } → envoie un lien si l'email est connu (toujours 204)
 *   POST /auth/magic-link/verify  { token } → ouvre une session, pose le cookie
 *   GET  /auth/me                           → l'utilisateur connecté
 *   POST /auth/logout                       → révoque la session, efface le cookie
 *
 * La validation passe par un POST, pas par un GET sur le lien : les antivirus de
 * messagerie ouvrent les liens des mails et consommeraient le jeton à usage unique.
 * Le lien mène donc au front, qui envoie le jeton ici.
 */
@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Post("magic-link")
  @HttpCode(204)
  async requestMagicLink(@Body() body: { email?: unknown }) {
    if (typeof body?.email !== "string" || !body.email.trim()) throw new BadRequestException("email requis");
    await this.auth.requestMagicLink(body.email);
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
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = readSessionCookie(req);
    if (token) await this.auth.revokeSession(token);
    clearSessionCookie(res, this.config);
  }
}
