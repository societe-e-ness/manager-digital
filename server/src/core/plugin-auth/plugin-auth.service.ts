import { HttpStatus, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import type { AuthenticatedUser } from "../auth/auth.service";
import { newToken, sha256 } from "../crypto/tokens";
import { DatabaseService } from "../database/database.service";
import { ProblemException } from "../problems/problem.exception";
import { RightsService } from "../rights/rights.service";

/** Le seul client OAuth : le Plugin WP, client public (pas de secret, PKCE obligatoire). */
export const PLUGIN_CLIENT_ID = "wp-plugin";
const CODE_TTL_MS = 5 * 60 * 1000;
// la date de dernière utilisation d'un jeton n'est réécrite qu'au plus une fois par heure
const LAST_USED_EVERY_MS = 60 * 60 * 1000;

/** Une demande d'autorisation validée. */
export interface AuthorizeRequest {
  redirectUri: string;
  codeChallenge: string;
  state?: string;
}

/** Ce que porte un jeton du Plugin WP : une personne et un Site. */
export interface PluginPrincipal {
  user: AuthenticatedUser;
  siteId: number;
}

/**
 * Serveur d'autorisation OAuth 2.0 du Plugin WP (code d'autorisation + PKCE S256, RFC 6749 / 7636).
 * Le jeton délivré est opaque, stocké haché, sans expiration mais révocable.
 */
@Injectable()
export class PluginAuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    private readonly rights: RightsService,
  ) {}

  // --- Demande d'autorisation ----------------------------------------------

  /**
   * Valide la demande. L'URL de retour doit mener à un Site connu du Manager Digital : sinon on ne
   * peut rien y renvoyer, pas même un refus (ce serait une redirection ouverte) : 400.
   */
  async validateAuthorizeRequest(params: Record<string, unknown>): Promise<AuthorizeRequest> {
    const request = this.parseAuthorizeRequest(params);
    const known = await this.db.site.count({ where: { domain: { in: domainCandidates(request.redirectUri) } } });
    if (known === 0) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        "oauth-invalid-request",
        "Demande d'autorisation invalide",
        "redirect_uri ne mène à aucun Site connu du Manager Digital",
      );
    }
    return request;
  }

  private parseAuthorizeRequest(params: Record<string, unknown>): AuthorizeRequest {
    const invalid = (detail: string) =>
      new ProblemException(HttpStatus.BAD_REQUEST, "oauth-invalid-request", "Demande d'autorisation invalide", detail);

    if (params.response_type !== "code") throw invalid("response_type doit valoir code");
    if (params.client_id !== PLUGIN_CLIENT_ID) throw invalid(`client_id inconnu (attendu : ${PLUGIN_CLIENT_ID})`);
    if (typeof params.redirect_uri !== "string" || !this.isAllowedRedirectUri(params.redirect_uri)) {
      throw invalid("redirect_uri requise : une URL HTTPS absolue, sans fragment");
    }
    if (params.code_challenge_method !== "S256") throw invalid("code_challenge_method doit valoir S256");
    if (typeof params.code_challenge !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(params.code_challenge)) {
      throw invalid("code_challenge requis (PKCE S256, base64url)");
    }
    if (params.state !== undefined && (typeof params.state !== "string" || params.state.length > 500)) {
      throw invalid("state invalide");
    }
    return { redirectUri: params.redirect_uri, codeChallenge: params.code_challenge, state: params.state };
  }

  /** HTTPS, ou HTTP hors production (WordPress local). */
  private isAllowedRedirectUri(value: string) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    const httpAllowed = this.config.get("NODE_ENV") !== "production";
    return (url.protocol === "https:" || (httpAllowed && url.protocol === "http:")) && !url.hash;
  }

  /**
   * Les Sites que l'utilisateur peut autoriser pour cette URL de retour : ceux de ses Clients
   * (tous pour l'agence) dont le domaine est celui de l'URL de retour. Le code ne part ainsi
   * jamais ailleurs que sur le Site autorisé.
   */
  async authorizableSites(user: AuthenticatedUser, redirectUri: string) {
    const visible = await this.rights.visibleClients(user);
    const sites = await this.db.site.findMany({
      where: {
        domain: { in: domainCandidates(redirectUri) },
        ...(visible === "all" ? {} : { client_id: { in: visible } }),
      },
      include: { client: { select: { name: true } } },
      orderBy: { domain: "asc" },
    });
    return sites.map((s) => ({ id: s.id, domain: s.domain, client: s.client.name }));
  }

  /** L'utilisateur autorise un Site : un code à usage unique, renvoyé au Plugin WP. */
  async approve(user: AuthenticatedUser, request: AuthorizeRequest, siteId: unknown) {
    const sites = await this.authorizableSites(user, request.redirectUri);
    if (!sites.some((s) => s.id === siteId)) {
      throw new ProblemException(
        HttpStatus.FORBIDDEN,
        "site-not-authorizable",
        "Site non autorisable",
        "Ce Site n'appartient pas à vos Clients, ou n'est pas celui où le Plugin WP est installé",
      );
    }

    // les codes ne servent qu'une fois et quelques minutes : on fait le ménage au passage
    await this.db.pluginAuthorizationCode.deleteMany({ where: { expires_at: { lt: new Date(Date.now() - 24 * 3600 * 1000) } } });

    const code = newToken();
    await this.db.pluginAuthorizationCode.create({
      data: {
        hash: sha256(code),
        user_id: user.id,
        site_id: siteId as number,
        redirect_uri: request.redirectUri,
        code_challenge: request.codeChallenge,
        expires_at: new Date(Date.now() + CODE_TTL_MS),
      },
    });
    return withParams(request.redirectUri, { code, state: request.state });
  }

  /** L'utilisateur refuse : le Plugin WP reçoit access_denied. */
  deny(request: AuthorizeRequest) {
    return withParams(request.redirectUri, { error: "access_denied", state: request.state });
  }

  // --- Échange du code ------------------------------------------------------

  async exchangeCode(params: Record<string, unknown>) {
    if (params.grant_type !== "authorization_code") {
      throw oauthError(HttpStatus.BAD_REQUEST, "unsupported_grant_type", "Seul grant_type=authorization_code est accepté");
    }
    if (params.client_id !== PLUGIN_CLIENT_ID) {
      throw oauthError(HttpStatus.UNAUTHORIZED, "invalid_client", `client_id inconnu (attendu : ${PLUGIN_CLIENT_ID})`);
    }
    const { code, redirect_uri, code_verifier } = params;
    if (typeof code !== "string" || typeof redirect_uri !== "string" || typeof code_verifier !== "string") {
      throw oauthError(HttpStatus.BAD_REQUEST, "invalid_request", "code, redirect_uri et code_verifier sont requis");
    }

    // Usage unique, en un UPDATE conditionnel : même un échange raté consomme le code.
    const hash = sha256(code);
    const now = new Date();
    const { count } = await this.db.pluginAuthorizationCode.updateMany({
      where: { hash, used_at: null, expires_at: { gt: now } },
      data: { used_at: now },
    });
    const invalidGrant = () =>
      oauthError(HttpStatus.BAD_REQUEST, "invalid_grant", "Code invalide, expiré, déjà utilisé, ou qui ne correspond pas à la demande");
    if (count !== 1) throw invalidGrant();

    const stored = await this.db.pluginAuthorizationCode.findUniqueOrThrow({ where: { hash } });
    const challenge = createHash("sha256").update(code_verifier).digest("base64url");
    if (stored.redirect_uri !== redirect_uri || stored.code_challenge !== challenge) throw invalidGrant();

    // une autorisation par personne et par Site : la précédente est révoquée. Le verrou sur la
    // personne empêche deux échanges simultanés de laisser deux autorisations actives.
    const accessToken = newToken();
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM "users" WHERE "id" = ${stored.user_id} FOR UPDATE`;
      await tx.pluginAuthorization.updateMany({
        where: { user_id: stored.user_id, site_id: stored.site_id, revoked_at: null },
        data: { revoked_at: now },
      });
      await tx.pluginAuthorization.create({
        data: { user_id: stored.user_id, site_id: stored.site_id, token_hash: sha256(accessToken) },
      });
    });
    return { access_token: accessToken, token_type: "Bearer" };
  }

  // --- Jetons ---------------------------------------------------------------

  /**
   * La personne et le Site d'un jeton, ou null s'il est inconnu, révoqué, ou si la personne
   * n'appartient plus au Client du Site.
   */
  async resolveToken(token: string): Promise<PluginPrincipal | null> {
    const grant = await this.db.pluginAuthorization.findUnique({
      where: { token_hash: sha256(token) },
      include: { user: true, site: { select: { client_id: true } } },
    });
    if (!grant || grant.revoked_at) return null;

    const { id, email, name, type } = grant.user;
    const user = { id, email, name, type };
    const visible = await this.rights.visibleClients(user);
    if (visible !== "all" && !visible.includes(grant.site.client_id)) return null;

    if (!grant.last_used_at || Date.now() - grant.last_used_at.getTime() > LAST_USED_EVERY_MS) {
      await this.db.pluginAuthorization.update({ where: { id: grant.id }, data: { last_used_at: new Date() } });
    }
    return { user, siteId: grant.site_id };
  }

  /** RFC 7009 : le Plugin WP se déconnecte. Un jeton inconnu ne change rien. */
  async revokeToken(token: unknown) {
    if (typeof token !== "string" || !token) return;
    await this.db.pluginAuthorization.updateMany({
      where: { token_hash: sha256(token), revoked_at: null },
      data: { revoked_at: new Date() },
    });
  }

  // --- Gestion depuis le Manager Digital ------------------------------------

  /** Les autorisations actives : les siennes, ou toutes pour l'agence. Jamais de jeton. */
  async listAuthorizations(user: AuthenticatedUser) {
    const grants = await this.db.pluginAuthorization.findMany({
      where: { revoked_at: null, ...(user.type === "AGENCY" ? {} : { user_id: user.id }) },
      include: { site: { select: { id: true, domain: true } }, user: { select: { id: true, email: true, name: true } } },
      orderBy: { created_at: "asc" },
    });
    return grants.map((g) => ({ id: g.id, site: g.site, user: g.user, created_at: g.created_at, last_used_at: g.last_used_at }));
  }

  /** Révoque une autorisation : la sienne, ou n'importe laquelle pour l'agence. */
  async revokeAuthorization(user: AuthenticatedUser, id: number) {
    const grant = await this.db.pluginAuthorization.findUnique({ where: { id } });
    if (!grant || grant.revoked_at) {
      throw new ProblemException(
        HttpStatus.NOT_FOUND,
        "plugin-authorization-not-found",
        "Autorisation introuvable",
        `Autorisation ${id} introuvable ou déjà révoquée`,
      );
    }
    if (user.type !== "AGENCY" && grant.user_id !== user.id) {
      throw new ProblemException(
        HttpStatus.FORBIDDEN,
        "not-authorization-owner",
        "Autorisation d'une autre personne",
        "Seule la personne qui a autorisé le Plugin WP, ou l'agence, peut révoquer cet accès",
      );
    }
    await this.db.pluginAuthorization.update({ where: { id }, data: { revoked_at: new Date() } });
  }
}

/** Les domaines de Site qui correspondent à une URL de retour (avec ou sans www.). */
function domainCandidates(redirectUri: string) {
  const host = new URL(redirectUri).hostname.toLowerCase().replace(/^www\./, "");
  return [host, `www.${host}`];
}

/** Ajoute des paramètres à l'URL de retour du Plugin WP (en gardant les siens). */
function withParams(url: string, params: Record<string, string | undefined>) {
  const result = new URL(url);
  for (const [name, value] of Object.entries(params)) if (value !== undefined) result.searchParams.set(name, value);
  return result.href;
}

/**
 * Erreur du point de jeton : Problem Details, plus le champ `error` du RFC 6749 que lisent
 * les bibliothèques OAuth.
 */
function oauthError(status: HttpStatus, error: string, detail: string) {
  return new ProblemException(status, `oauth-${error.replaceAll("_", "-")}`, "Échange OAuth refusé", detail, { error });
}
