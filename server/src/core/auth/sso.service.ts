import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type * as Jose from "jose";
import type * as OpenIdClient from "openid-client";
import type { UserType } from "../../generated/prisma/client";
import { decrypt, encrypt, encryptionKey } from "../crypto/encryption";
import { ProblemException } from "../problems/problem.exception";

// jose et openid-client sont des modules ESM uniquement : chargés par import(), qui fonctionne
// depuis du CommonJS partout, alors qu'un require() de module ESM est refusé par certains
// environnements (le lanceur de fonctions Vercel : ERR_REQUIRE_ESM).
const loadJose = () => import("jose");
const loadOpenIdClient = () => import("openid-client");

const FLOW_TTL_MS = 10 * 60 * 1000;
const BACKCHANNEL_EVENT = "http://schemas.openid.net/event/backchannel-logout";

/** Ce qu'il faut garder entre l'aller vers auth.eness et le retour. */
export interface SsoFlow {
  codeVerifier: string;
  state: string;
  nonce: string;
  returnTo: string;
  expiresAt: number;
}

/** L'identité renvoyée par auth.eness après une connexion réussie. */
export interface SsoIdentity {
  sub: string;
  email: string;
  emailVerified: boolean; // seul un email vérifié permet de rattacher un compte existant
  name?: string;
  type?: UserType; // traduit depuis le claim `type` (staff / client)
  sid?: string;
  idToken: string;
  refreshToken?: string; // CHIFFRÉ
}

/**
 * Le seul fichier qui parle à auth.eness (OpenID Connect, code d'autorisation + PKCE).
 * La découverte se fait au premier usage : l'application démarre même si auth.eness
 * est injoignable, et seul le SSO est alors indisponible.
 */
@Injectable()
export class SsoService {
  private readonly logger = new Logger(SsoService.name);
  private readonly key: Buffer;
  private configuration?: Promise<OpenIdClient.Configuration>;
  private jwks?: ReturnType<typeof Jose.createRemoteJWKSet>;

  constructor(private readonly config: ConfigService) {
    this.key = encryptionKey(config.getOrThrow<string>("ENCRYPTION_KEY"));
  }

  get enabled() {
    return this.config.get<boolean>("SSO_ENABLED") === true;
  }

  // --- Aller ------------------------------------------------------------------

  /** L'URL d'auth.eness, et le flux (chiffré) à garder dans un cookie jusqu'au retour. */
  async startLogin(returnTo: unknown) {
    const oidc = await this.oidc();
    const client = await loadOpenIdClient();
    const flow: SsoFlow = {
      codeVerifier: client.randomPKCECodeVerifier(),
      state: client.randomState(),
      nonce: client.randomNonce(),
      returnTo: safeReturnTo(returnTo),
      expiresAt: Date.now() + FLOW_TTL_MS,
    };

    const url = client.buildAuthorizationUrl(oidc, {
      redirect_uri: this.callbackUrl,
      // pas de scope `roles` : auth.eness ne sert qu'à dire qui entre, les droits sont gérés ici
      scope: "openid email profile",
      code_challenge: await client.calculatePKCECodeChallenge(flow.codeVerifier),
      code_challenge_method: "S256",
      state: flow.state,
      nonce: flow.nonce,
      // sans `resource`, auth.eness affiche un consentement inutile et une erreur
      // technique au lieu de l'écran « accès refusé »
      resource: this.config.getOrThrow<string>("OIDC_RESOURCE"),
    });

    return { url: url.href, flow: encrypt(this.key, JSON.stringify(flow)), maxAgeMs: FLOW_TTL_MS };
  }

  /** Le flux relu depuis son cookie, ou null s'il est absent, abîmé ou périmé. */
  readFlow(stored: string | undefined): SsoFlow | null {
    if (!stored) return null;
    try {
      const flow = JSON.parse(decrypt(this.key, stored)) as SsoFlow;
      return flow.expiresAt > Date.now() ? flow : null;
    } catch {
      return null;
    }
  }

  // --- Retour -----------------------------------------------------------------

  /**
   * Échange le code contre les jetons. La bibliothèque vérifie signature, émetteur,
   * audience, expiration, state, nonce et PKCE.
   */
  async completeLogin(currentUrl: URL, flow: SsoFlow): Promise<SsoIdentity> {
    const oidc = await this.oidc();
    const client = await loadOpenIdClient();

    let tokens: Awaited<ReturnType<typeof OpenIdClient.authorizationCodeGrant>>;
    try {
      tokens = await client.authorizationCodeGrant(oidc, currentUrl, {
        pkceCodeVerifier: flow.codeVerifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
        idTokenExpected: true,
      });
    } catch (e) {
      this.logger.warn(`Retour SSO refusé : ${e instanceof Error ? e.message : String(e)}`);
      throw new ProblemException(
        HttpStatus.UNAUTHORIZED,
        "sso-failed",
        "Connexion SSO impossible",
        "auth.eness a refusé la connexion, ou la réponse n'a pas pu être vérifiée : recommencer",
      );
    }

    const claims = tokens.claims()!;
    return {
      sub: claims.sub,
      email: String(claims.email ?? ""),
      emailVerified: claims.email_verified === true,
      name: typeof claims.name === "string" ? claims.name : undefined,
      type: claims.type === "staff" ? "AGENCY" : claims.type === "client" ? "CLIENT" : undefined,
      sid: typeof claims.sid === "string" ? claims.sid : undefined,
      idToken: tokens.id_token!,
      refreshToken: tokens.refresh_token ? encrypt(this.key, tokens.refresh_token) : undefined,
    };
  }

  // --- Revérification ---------------------------------------------------------

  /**
   * Redemande à auth.eness si la personne a toujours accès (auth relit les accès à
   * chaque refresh). Trois issues :
   *  - "ok" : accès confirmé ;
   *  - "lost" : auth.eness refuse (accès retiré, compte désactivé, refresh expiré) ;
   *  - "unavailable" : auth.eness injoignable ou SSO désactivé. On ne déconnecte pas
   *    pour une panne : la session sera revérifiée plus tard.
   */
  async recheck(encryptedRefreshToken: string | null): Promise<SsoRecheck> {
    if (!encryptedRefreshToken) return { status: "lost" };
    const client = await loadOpenIdClient();

    let tokens: Awaited<ReturnType<typeof OpenIdClient.refreshTokenGrant>>;
    try {
      tokens = await client.refreshTokenGrant(await this.oidc(), decrypt(this.key, encryptedRefreshToken));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof client.ResponseBodyError) {
        this.logger.warn(`Revérification SSO refusée par auth.eness : ${e.error}`);
        return { status: "lost" };
      }
      this.logger.warn(`Revérification SSO impossible (auth.eness indisponible ?) : ${message}`);
      return { status: "unavailable" };
    }

    return {
      status: "ok",
      idToken: tokens.id_token,
      // auth.eness peut renouveler le refresh token : on garde le plus récent
      refreshToken: tokens.refresh_token ? encrypt(this.key, tokens.refresh_token) : undefined,
    };
  }

  // --- Déconnexion ------------------------------------------------------------

  /** L'écran de déconnexion d'auth.eness (revenir sur l'application, ou quitter tous les services). */
  async endSessionUrl(idToken: string) {
    const client = await loadOpenIdClient();
    const url = client.buildEndSessionUrl(await this.oidc(), {
      id_token_hint: idToken,
      post_logout_redirect_uri: `${this.config.getOrThrow<string>("CLIENT_PUBLIC_URL")}/`,
    });
    return url.href;
  }

  /**
   * Vérifie un logout_token de back-channel. Il désigne la session SSO à fermer (`sid`),
   * ou toutes les sessions d'une personne (`sub`) : au moins l'un des deux.
   */
  async verifyLogoutToken(token: unknown): Promise<{ sid?: string; sub?: string }> {
    const oidc = await this.oidc();
    const jose = await loadJose();
    try {
      if (typeof token !== "string") throw new Error("logout_token absent");
      const metadata = oidc.serverMetadata();
      this.jwks ??= jose.createRemoteJWKSet(new URL(metadata.jwks_uri!));

      // endpoint public : la signature DOIT être vérifiée
      const { payload } = await jose.jwtVerify(token, this.jwks, {
        issuer: metadata.issuer,
        audience: this.config.getOrThrow<string>("OIDC_CLIENT_ID"),
      });
      const events = payload.events as Record<string, unknown> | undefined;
      if (!events?.[BACKCHANNEL_EVENT]) throw new Error("événement de back-channel absent");
      if (payload.nonce !== undefined) throw new Error("un logout_token ne porte pas de nonce");
      const sid = typeof payload.sid === "string" ? payload.sid : undefined;
      const sub = typeof payload.sub === "string" ? payload.sub : undefined;
      if (!sid && !sub) throw new Error("ni sid ni sub");
      return { sid, sub };
    } catch (e) {
      this.logger.warn(`Back-channel refusé : ${e instanceof Error ? e.message : String(e)}`);
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        "sso-logout-token-invalid",
        "Jeton de déconnexion invalide",
        "Le logout_token est absent, mal signé ou incomplet",
      );
    }
  }

  // --- Configuration ----------------------------------------------------------

  private get callbackUrl() {
    return `${this.config.getOrThrow<string>("APP_PUBLIC_URL")}/auth/sso/callback`;
  }

  /** La configuration découverte (endpoints, clés de signature). Retentée si la découverte a échoué. */
  private oidc() {
    if (!this.enabled) {
      throw new ProblemException(
        HttpStatus.SERVICE_UNAVAILABLE,
        "sso-disabled",
        "SSO désactivé",
        "La connexion SSO n'est pas activée : utiliser le lien magique",
      );
    }
    this.configuration ??= loadOpenIdClient()
      .then((client) =>
        client.discovery(
          new URL(this.config.getOrThrow<string>("OIDC_ISSUER")),
          this.config.getOrThrow<string>("OIDC_CLIENT_ID"),
          undefined,
          client.ClientSecretBasic(this.config.getOrThrow<string>("OIDC_CLIENT_SECRET")),
        ),
      )
      .catch((e: unknown) => {
        this.configuration = undefined;
        throw e;
      });
    return this.configuration;
  }
}

export type SsoRecheck =
  | { status: "ok"; idToken?: string; refreshToken?: string }
  | { status: "lost" }
  | { status: "unavailable" };

/** N'accepte qu'un chemin local, sinon c'est une redirection ouverte. */
export function safeReturnTo(path: unknown) {
  return typeof path === "string" && /^\/(?![/\\])/.test(path) && !path.includes("\\") ? path : "/";
}
