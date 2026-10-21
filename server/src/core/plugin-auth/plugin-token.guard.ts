import { CanActivate, createParamDecorator, ExecutionContext, HttpStatus, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { ProblemException } from "../problems/problem.exception";
import { PluginAuthService, type PluginPrincipal } from "./plugin-auth.service";

type PluginRequest = Request & { plugin: PluginPrincipal };

/** La personne et le Site du jeton, sur une route du Plugin WP. Le Site ne vient jamais d'un paramètre. */
export const CurrentPlugin = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<PluginRequest>().plugin,
);

/**
 * Garde des routes du Plugin WP : `Authorization: Bearer <jeton>`. Le cookie de session n'y
 * suffit pas (les contrôleurs sont @Public() pour la garde de session, et portent celle-ci).
 */
@Injectable()
export class PluginTokenGuard implements CanActivate {
  constructor(private readonly pluginAuth: PluginAuthService) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<PluginRequest>();
    const token = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    const principal = token ? await this.pluginAuth.resolveToken(token) : null;
    if (!principal) {
      throw new ProblemException(
        HttpStatus.UNAUTHORIZED,
        "plugin-token-invalid",
        "Jeton du Plugin WP invalide",
        "Jeton absent, invalide ou révoqué : reconnecter le Plugin WP au Manager Digital",
      );
    }
    req.plugin = principal;
    return true;
  }
}
