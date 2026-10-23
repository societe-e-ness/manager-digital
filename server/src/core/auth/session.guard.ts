import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  HttpStatus,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import type { Request, Response } from "express";
import { ProblemException } from "../problems/problem.exception";
import { AuthService, type AuthenticatedUser } from "./auth.service";
import { readSessionCookie, setSessionCookie } from "./session-cookie";

const IS_PUBLIC = "isPublic";

/** Ouvre une route (ou tout un contrôleur) sans session. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** L'utilisateur de la session, sur une route protégée. */
export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AuthenticatedRequest>().user,
);

type AuthenticatedRequest = Request & { user: AuthenticatedUser };

/**
 * Garde globale : toute route exige une session valide, sauf celles marquées @Public().
 * Renvoie le cookie quand la session vient d'être prolongée.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;

    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = readSessionCookie(req);
    const session = token ? await this.auth.resolveSession(token) : null;
    if (!token || !session) {
      throw new ProblemException(
        HttpStatus.UNAUTHORIZED,
        "unauthenticated",
        "Connexion requise",
        "Session absente, expirée ou révoquée : se reconnecter",
      );
    }

    req.user = session.user;
    if (session.extended) {
      setSessionCookie(ctx.switchToHttp().getResponse<Response>(), this.config, token, session.expiresAt);
    }
    return true;
  }
}
