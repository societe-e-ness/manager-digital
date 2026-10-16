import { createHash, randomUUID } from "node:crypto";
import * as jose from "jose";
import { interceptHost, jsonResponse, releaseHost } from "./network";

export const ISSUER = "https://auth.test";
export const CLIENT_ID = "manager-digital";
export const CLIENT_SECRET = "test-oidc-secret";
export const RESOURCE = "https://manager-digital.test/";

/** Un compte auth.eness, tel que le faux le connaît. */
export interface FakeAccount {
  sub: string;
  email: string;
  emailVerified?: boolean; // vrai par défaut
  name?: string;
  type?: "staff" | "client";
  roles?: string[]; // [] ou absent = aucun rôle
  hasAccess?: boolean; // false = accès retiré : le refresh échoue
}

interface PendingCode {
  account: FakeAccount;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
  sid: string;
}

/**
 * Un faux auth.eness (OpenID Connect) : découverte, JWKS, /token (code + refresh),
 * avec de vrais ID tokens signés par une clé générée pour le test.
 * Le navigateur est simulé par `approve()`, qui fait ce que ferait l'écran de connexion.
 */
export class FakeAuthEness {
  readonly accounts = new Map<string, FakeAccount>();
  private codes = new Map<string, PendingCode>();
  private refreshTokens = new Map<string, { sub: string; sid: string }>();
  private keys?: { privateKey: CryptoKey; jwk: jose.JWK };
  tokenRequests = 0;
  /** Simule une panne réseau : toute requête vers auth.eness échoue. */
  down = false;

  async install() {
    if (!this.keys) {
      const { privateKey, publicKey } = await jose.generateKeyPair("RS256", { extractable: true });
      this.keys = { privateKey, jwk: { ...(await jose.exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" } };
    }
    this.accounts.clear();
    this.codes.clear();
    this.refreshTokens.clear();
    this.tokenRequests = 0;
    this.down = false;
    interceptHost(new URL(ISSUER).hostname, (req) => this.handle(req.method, req.url, req.headers, req.body));
  }

  uninstall() {
    releaseHost(new URL(ISSUER).hostname);
  }

  addAccount(account: FakeAccount) {
    this.accounts.set(account.sub, { type: "staff", roles: ["admin"], hasAccess: true, emailVerified: true, ...account });
    return this;
  }

  /**
   * Le passage par l'écran d'auth.eness : prend l'URL d'autorisation vers laquelle
   * l'application a redirigé, et renvoie le chemin de callback (avec code et state).
   */
  approve(authorizationUrl: string, sub: string) {
    const url = new URL(authorizationUrl);
    const account = this.accounts.get(sub);
    if (!account) throw new Error(`Compte ${sub} inconnu du faux auth.eness`);

    const code = randomUUID();
    this.codes.set(code, {
      account,
      nonce: url.searchParams.get("nonce") ?? "",
      codeChallenge: url.searchParams.get("code_challenge") ?? "",
      redirectUri: url.searchParams.get("redirect_uri") ?? "",
      sid: `sid-${sub}`,
    });

    const callback = new URL(url.searchParams.get("redirect_uri")!);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", url.searchParams.get("state") ?? "");
    return `${callback.pathname}${callback.search}`;
  }

  /** Un logout_token de back-channel (par `sid` ou par `sub`), signé par auth.eness ou par une autre clé si `forged`. */
  async logoutToken(target: { sid?: string; sub?: string }, { forged = false } = {}) {
    const key = forged ? (await jose.generateKeyPair("RS256")).privateKey : this.keys!.privateKey;
    const jwt = new jose.SignJWT({ ...(target.sid ? { sid: target.sid } : {}), events: { "http://schemas.openid.net/event/backchannel-logout": {} } })
      .setProtectedHeader({ alg: "RS256", kid: "test-key", typ: "logout+jwt" })
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setIssuedAt()
      .setJti(randomUUID());
    if (target.sub) jwt.setSubject(target.sub);
    return jwt.sign(key);
  }

  // --- Serveur ---------------------------------------------------------------

  private async handle(method: string, url: URL, headers: Headers, body?: string) {
    if (this.down) throw new TypeError("fetch failed (auth.eness simulé en panne)");
    if (method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      return jsonResponse({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/auth`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        end_session_endpoint: `${ISSUER}/session/end`,
        response_types_supported: ["code"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
      });
    }
    if (method === "GET" && url.pathname === "/jwks") return jsonResponse({ keys: [this.keys!.jwk] });
    if (method === "POST" && url.pathname === "/token") return this.token(headers, new URLSearchParams(body));
    return undefined;
  }

  private async token(headers: Headers, params: URLSearchParams) {
    this.tokenRequests++;
    // client_secret_basic : identifiants encodés en application/x-www-form-urlencoded (RFC 6749 § 2.3.1)
    const basic = Buffer.from((headers.get("authorization") ?? "").replace(/^Basic /, ""), "base64").toString("utf8");
    const [id, secret] = basic.split(":").map((part) => decodeURIComponent(part.replace(/\+/g, " ")));
    if (id !== CLIENT_ID || secret !== CLIENT_SECRET) return jsonResponse({ error: "invalid_client" }, 401);

    if (params.get("grant_type") === "authorization_code") {
      const pending = this.codes.get(params.get("code") ?? "");
      this.codes.delete(params.get("code") ?? "");
      const verifier = params.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (!pending || challenge !== pending.codeChallenge || params.get("redirect_uri") !== pending.redirectUri) {
        return jsonResponse({ error: "invalid_grant" }, 400);
      }
      return this.issueTokens(pending.account, pending.sid, pending.nonce);
    }

    if (params.get("grant_type") === "refresh_token") {
      const stored = this.refreshTokens.get(params.get("refresh_token") ?? "");
      const account = stored && this.accounts.get(stored.sub);
      if (!stored || !account?.hasAccess) return jsonResponse({ error: "invalid_grant" }, 400);
      this.refreshTokens.delete(params.get("refresh_token")!);
      return this.issueTokens(account, stored.sid);
    }

    return jsonResponse({ error: "unsupported_grant_type" }, 400);
  }

  private async issueTokens(account: FakeAccount, sid: string, nonce?: string) {
    const claims: jose.JWTPayload = {
      email: account.email,
      email_verified: account.emailVerified,
      name: account.name,
      type: account.type,
      roles: account.roles,
      sid,
      ...(nonce ? { nonce } : {}),
    };
    const idToken = await new jose.SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setSubject(account.sub)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(this.keys!.privateKey);

    const refreshToken = randomUUID();
    this.refreshTokens.set(refreshToken, { sub: account.sub, sid });
    return jsonResponse({
      access_token: randomUUID(),
      token_type: "Bearer",
      expires_in: 3600,
      id_token: idToken,
      refresh_token: refreshToken,
    });
  }
}
