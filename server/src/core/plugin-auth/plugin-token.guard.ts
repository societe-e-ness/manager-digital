import { CanActivate, createParamDecorator, ExecutionContext, HttpStatus, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { ProblemException } from "../problems/problem.exception";
import { missingFeature, RightsService } from "../rights/rights.service";
import { PluginAuthService, type PluginPrincipal } from "./plugin-auth.service";

type PluginRequest = Request & { plugin: PluginPrincipal };

const PLUGIN_FEATURES = "pluginFeatures";

/**
 * Exige au moins une de ces Fonctionnalités sur le Site du jeton. Vérifié par la garde, donc avant
 * la lecture du corps (images d'une Diffusion comprises). Sinon : 403 `missing-feature` (la première).
 */
export const RequiresAnyFeature = (...slugs: string[]) => SetMetadata(PLUGIN_FEATURES, slugs);

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
  constructor(
    private readonly pluginAuth: PluginAuthService,
    private readonly rights: RightsService,
    private readonly reflector: Reflector,
  ) {}

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

    const slugs = this.reflector.getAllAndOverride<string[] | undefined>(PLUGIN_FEATURES, [ctx.getHandler(), ctx.getClass()]);
    if (slugs?.length) {
      const scope = { siteId: principal.siteId };
      const granted = await Promise.all(slugs.map((slug) => this.rights.hasFeature(principal.user, slug, scope)));
      if (!granted.includes(true)) throw missingFeature(slugs[0]);
    }
    return true;
  }
}
