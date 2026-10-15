import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { DatabaseService } from "../src/core/database/database.service";
import { createTestApp, magicLinks, resetDatabase } from "./support/app";
import { loginAs, tokenFromLink } from "./support/auth";

describe("Connexion par lien magique et sessions (HTTP)", () => {
  let app: INestApplication;
  let db: DatabaseService;

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DatabaseService);
  });

  beforeEach(async () => {
    await resetDatabase(db);
    magicLinks(app).sent.length = 0;
    await db.user.create({ data: { email: "marie@client-a.fr", name: "Marie", type: "CLIENT" } });
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  describe("demande d'un lien", () => {
    it("envoie un lien à usage unique pour un email connu, stocké haché", async () => {
      await http().post("/auth/magic-link").send({ email: "marie@client-a.fr" }).expect(204);

      const [sent] = magicLinks(app).sent;
      expect(sent.email).toBe("marie@client-a.fr");
      const token = tokenFromLink(sent.link);

      const [stored] = await db.loginToken.findMany();
      expect(stored.hash).not.toBe(token);
      expect(stored.hash).not.toContain(token);
      const minutes = (stored.expires_at.getTime() - Date.now()) / 60_000;
      expect(minutes).toBeGreaterThan(14);
      expect(minutes).toBeLessThanOrEqual(15);
    });

    it("ignore la casse et les espaces de l'email", async () => {
      await http().post("/auth/magic-link").send({ email: "  Marie@Client-A.fr " }).expect(204);
      expect(magicLinks(app).sent).toHaveLength(1);
    });

    it("répond pareil pour un email inconnu, sans rien envoyer", async () => {
      const res = await http().post("/auth/magic-link").send({ email: "inconnu@test.fr" }).expect(204);
      expect(res.text).toBe("");
      expect(magicLinks(app).sent).toHaveLength(0);
      expect(await db.loginToken.count()).toBe(0);
    });

    it("refuse une requête sans email (400 Problem Details)", async () => {
      const res = await http().post("/auth/magic-link").send({}).expect(400);
      expect(res.body.status).toBe(400);
    });
  });

  describe("validation du lien", () => {
    async function requestLink() {
      await http().post("/auth/magic-link").send({ email: "marie@client-a.fr" }).expect(204);
      return tokenFromLink(magicLinks(app).sent.at(-1)!.link);
    }

    it("crée une session par lien magique et pose un cookie httpOnly", async () => {
      const token = await requestLink();

      const res = await http().post("/auth/magic-link/verify").send({ token }).expect(200);

      expect(res.body).toMatchObject({ email: "marie@client-a.fr", type: "CLIENT" });
      const cookie = res.headers["set-cookie"]?.[0] ?? "";
      expect(cookie).toMatch(/^md_session=/);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);

      const [session] = await db.session.findMany();
      expect(session.method).toBe("MAGIC_LINK");
      expect(cookie).not.toContain(session.id); // seul le hash est stocké
    });

    it("refuse un lien déjà utilisé", async () => {
      const token = await requestLink();
      await http().post("/auth/magic-link/verify").send({ token }).expect(200);

      const res = await http().post("/auth/magic-link/verify").send({ token }).expect(401);
      expect(res.body.type).toBe("magic-link-invalid");
    });

    it("refuse un lien expiré", async () => {
      const token = await requestLink();
      await db.loginToken.updateMany({ data: { expires_at: new Date(Date.now() - 1000) } });

      const res = await http().post("/auth/magic-link/verify").send({ token }).expect(401);
      expect(res.body.type).toBe("magic-link-invalid");
    });

    it("refuse un lien inventé", async () => {
      const res = await http().post("/auth/magic-link/verify").send({ token: "n-importe-quoi" }).expect(401);
      expect(res.body.type).toBe("magic-link-invalid");
    });
  });

  describe("session", () => {
    it("donne accès aux routes protégées, puis la déconnexion coupe l'accès", async () => {
      const agent = await loginAs(app, "marie@client-a.fr");

      const me = await agent.get("/auth/me").expect(200);
      expect(me.body.email).toBe("marie@client-a.fr");
      await agent.get("/integrations").expect(200);

      await agent.post("/auth/logout").expect(204);

      const res = await agent.get("/auth/me").expect(401);
      expect(res.body.type).toBe("unauthenticated");
      expect((await db.session.findFirstOrThrow()).revoked_at).not.toBeNull();
    });

    it("refuse une session révoquée", async () => {
      const agent = await loginAs(app, "marie@client-a.fr");
      await db.session.updateMany({ data: { revoked_at: new Date() } });

      await agent.get("/auth/me").expect(401);
    });

    it("refuse une session expirée", async () => {
      const agent = await loginAs(app, "marie@client-a.fr");
      await db.session.updateMany({ data: { expires_at: new Date(Date.now() - 1000) } });

      await agent.get("/auth/me").expect(401);
    });

    it("prolonge une session encore valide (glissante)", async () => {
      const agent = await loginAs(app, "marie@client-a.fr");
      const soon = new Date(Date.now() + 24 * 3600 * 1000);
      await db.session.updateMany({ data: { expires_at: soon } });

      await agent.get("/auth/me").expect(200);

      const session = await db.session.findFirstOrThrow();
      expect(session.expires_at.getTime()).toBeGreaterThan(soon.getTime());
    });

    it("traite un cookie abîmé comme une absence de session (401, pas 500)", async () => {
      const res = await http().get("/auth/me").set("Cookie", "md_session=%E0%A4").expect(401);
      expect(res.body.type).toBe("unauthenticated");
    });

    it("garde les routes publiques ouvertes", async () => {
      await http().get("/health").expect(200);
    });
  });

  describe("routes de gestion des Intégrations", () => {
    it("exigent une session (401 Problem Details)", async () => {
      const res = await http().get("/integrations").expect(401).expect("Content-Type", /application\/problem\+json/);
      expect(res.body.type).toBe("unauthenticated");
    });

    it("la connexion d'un compte Meta prend l'utilisateur dans la session, pas dans la requête", async () => {
      const marie = await db.user.findUniqueOrThrow({ where: { email: "marie@client-a.fr" } });
      const agent = await loginAs(app, "marie@client-a.fr");

      const res = await agent.get("/integrations/oauth/connect?userId=999").expect(302);

      const state = new URL(res.headers.location).searchParams.get("state")!;
      const payload = JSON.parse(Buffer.from(state.split(".")[0], "base64url").toString("utf8"));
      expect(payload.userId).toBe(marie.id);
    });

    it("refuse un clientId non numérique au lieu d'en faire un accès agence", async () => {
      const agent = await loginAs(app, "marie@client-a.fr");
      await agent.get("/integrations/oauth/connect?clientId=abc").expect(400);
    });

    it("refuse un retour de Meta dont le state a été lancé par quelqu'un d'autre", async () => {
      await db.user.create({ data: { email: "pirate@test.fr", type: "CLIENT" } });
      const pirate = await loginAs(app, "pirate@test.fr");
      const marie = await loginAs(app, "marie@client-a.fr");

      // le pirate lance la connexion et récupère son state signé…
      const started = await pirate.get("/integrations/oauth/connect").expect(302);
      const state = new URL(started.headers.location).searchParams.get("state")!;

      // …que Marie termine depuis sa propre session : refusé avant tout appel à Meta
      const res = await marie.get(`/integrations/oauth/callback?code=abc&state=${state}`).expect(403);
      expect(res.body.type).toBe("oauth-state-mismatch");
    });
  });
});
