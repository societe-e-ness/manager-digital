import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { magicLinks } from "./app";

/** Le jeton contenu dans un lien magique envoyé. */
export function tokenFromLink(link: string) {
  const token = new URL(link).searchParams.get("token");
  if (!token) throw new Error(`Pas de jeton dans le lien ${link}`);
  return token;
}

/**
 * Connecte un utilisateur existant par le vrai parcours du lien magique et renvoie
 * un client HTTP qui garde le cookie de session.
 */
export async function loginAs(app: INestApplication, email: string) {
  const agent = request.agent(app.getHttpServer());
  await agent.post("/auth/magic-link").send({ email }).expect(204);
  const link = magicLinks(app).sent.filter((m) => m.email === email).at(-1);
  if (!link) throw new Error(`Aucun lien magique envoyé à ${email}`);
  await agent.post("/auth/magic-link/verify").send({ token: tokenFromLink(link.link) }).expect(200);
  return agent;
}
