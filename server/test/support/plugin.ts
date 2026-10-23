import type { INestApplication } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import request from "supertest";
import { magicLinks } from "./app";
import { tokenFromLink } from "./auth";

export const PLUGIN_CLIENT_ID = "wp-plugin";

/** Un vérificateur PKCE et son défi S256, comme les calcule une bibliothèque OAuth. */
export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** L'URL de retour du Plugin WP installé sur un Site. */
export function pluginRedirectUri(domain: string) {
  return `https://${domain}/wp-admin/admin.php?page=manager-digital`;
}

/** Les paramètres d'une demande d'autorisation valide. */
export function authorizeParams(redirectUri: string, challenge: string, state = "etat-123") {
  return {
    response_type: "code",
    client_id: PLUGIN_CLIENT_ID,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  };
}

/**
 * Le parcours OAuth complet du Plugin WP, comme dans la vraie vie : demande d'autorisation,
 * connexion par lien magique, choix du Site, échange du code. Renvoie le jeton du Plugin WP.
 */
export async function connectPlugin(app: INestApplication, email: string, siteId: number, domain: string) {
  const server = app.getHttpServer();
  const browser = request.agent(server);
  const { verifier, challenge } = pkce();
  const params = authorizeParams(pluginRedirectUri(domain), challenge);
  const query = new URLSearchParams(params).toString();

  // 1. non connecté : envoyé vers la connexion, avec le retour vers l'autorisation
  const toLogin = await browser.get(`/oauth/authorize?${query}`).expect(302);
  const returnTo = new URL(toLogin.headers.location).searchParams.get("returnTo")!;

  // 2. connexion par lien magique, qui ramène à l'autorisation
  await browser.post("/auth/magic-link").send({ email, returnTo }).expect(204);
  const link = magicLinks(app).sent.filter((m) => m.email === email).at(-1)!.link;
  await browser.post("/auth/magic-link/verify").send({ token: tokenFromLink(link) }).expect(200);

  // 3. choix du Site : le Manager Digital renvoie vers le Plugin WP avec un code
  const consent = await browser.post("/oauth/consent").send({ ...params, siteId, decision: "allow" }).expect(200);
  const code = new URL(consent.body.redirectTo).searchParams.get("code")!;

  // 4. le Plugin WP échange le code contre son jeton (serveur à serveur)
  const token = await request(server)
    .post("/oauth/token")
    .type("form")
    .send({ grant_type: "authorization_code", code, redirect_uri: params.redirect_uri, client_id: PLUGIN_CLIENT_ID, code_verifier: verifier })
    .expect(200);
  return token.body.access_token as string;
}

/** Un client HTTP du Plugin WP : chaque requête porte son jeton. */
export function asPlugin(app: INestApplication, accessToken: string) {
  const server = app.getHttpServer();
  return {
    get: (url: string) => request(server).get(url).set("Authorization", `Bearer ${accessToken}`),
    post: (url: string) => request(server).post(url).set("Authorization", `Bearer ${accessToken}`),
  };
}
