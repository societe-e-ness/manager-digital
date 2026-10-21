import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import type TestAgent from "supertest/lib/agent";
import { DatabaseService } from "../src/core/database/database.service";
import { IntegrationsService } from "../src/core/integrations/integrations.service";
import { createTestApp, magicLinks, resetDatabase } from "./support/app";
import { loginAs } from "./support/auth";
import {
  asPlugin,
  authorizeParams,
  connectPlugin,
  pkce,
  PLUGIN_CLIENT_ID,
  pluginRedirectUri,
} from "./support/plugin";
import { givenOverride, givenSite } from "./support/rights";

const FRONT = "http://localhost:5173";

describe("Connexion OAuth du Plugin WP (HTTP)", () => {
  let app: INestApplication;
  let db: DatabaseService;
  let clientA: number;
  let siteA: number;
  let siteB: number;
  let ids: { marie: number; alice: number };

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DatabaseService);
  });

  beforeEach(async () => {
    await resetDatabase(db);
    magicLinks(app).sent.length = 0;
    clientA = (await db.client.create({ data: { name: "Client A" } })).id;
    const clientB = (await db.client.create({ data: { name: "Client B" } })).id;
    siteA = (await givenSite(db, clientA, "site-a.fr", ["social.read"])).id;
    siteB = (await givenSite(db, clientB, "site-b.fr")).id;
    ids = {
      marie: (await db.user.create({ data: { email: "marie@client-a.fr", type: "CLIENT", clients: { create: { client_id: clientA } } } })).id,
      alice: (await db.user.create({ data: { email: "alice@agence.fr", type: "AGENCY" } })).id,
    };
    await givenOverride(db, ids.marie, "social.read", "ADD");
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const query = (params: Record<string, string>) => new URLSearchParams(params).toString();

  /** Une demande d'autorisation valide pour le Plugin WP de site-a.fr. */
  function validRequest(domain = "site-a.fr") {
    const { verifier, challenge } = pkce();
    return { verifier, params: authorizeParams(pluginRedirectUri(domain), challenge) };
  }

  function consent(browser: TestAgent, params: Record<string, string>, siteId: number) {
    return browser.post("/oauth/consent").send({ ...params, siteId, decision: "allow" });
  }

  function exchange(code: string, verifier: string, redirectUri = pluginRedirectUri("site-a.fr")) {
    return http()
      .post("/oauth/token")
      .type("form")
      .send({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: PLUGIN_CLIENT_ID, code_verifier: verifier });
  }

  /** Un code d'autorisation délivré à Marie pour site-a.fr. */
  async function codeForMarie() {
    const { verifier, params } = validRequest();
    const marie = await loginAs(app, "marie@client-a.fr");
    const res = await consent(marie, params, siteA).expect(200);
    return { verifier, code: new URL(res.body.redirectTo).searchParams.get("code")! };
  }

  describe("demande d'autorisation", () => {
    it.each([
      ["sans défi PKCE", { code_challenge: undefined }],
      ["avec un défi PKCE en clair", { code_challenge_method: "plain" }],
      ["sans URL de retour", { redirect_uri: undefined }],
      ["avec une URL de retour invalide", { redirect_uri: "pas-une-url" }],
      ["avec une URL de retour non HTTPS hors local", { redirect_uri: "ftp://site-a.fr/retour" }],
      ["pour un autre client OAuth", { client_id: "autre-app" }],
      ["avec une URL de retour qui ne mène à aucun Site connu", { redirect_uri: "https://pirate.fr/phishing" }],
      ["sans response_type=code", { response_type: "token" }],
    ])("est refusée %s (400 Problem Details)", async (_, override) => {
      const { params } = validRequest();
      const bad = Object.fromEntries(
        Object.entries({ ...params, ...override }).filter((entry): entry is [string, string] => entry[1] !== undefined),
      );

      const res = await http().get(`/oauth/authorize?${query(bad)}`).expect(400).expect("Content-Type", /application\/problem\+json/);
      expect(res.body.type).toBe("oauth-invalid-request");
    });

    it("envoie un utilisateur non connecté vers la connexion, qui le ramène à l'autorisation", async () => {
      const { params } = validRequest();
      const res = await http().get(`/oauth/authorize?${query(params)}`).expect(302);

      const location = new URL(res.headers.location);
      expect(location.origin + location.pathname).toBe(`${FRONT}/connexion`);
      const returnTo = location.searchParams.get("returnTo")!;
      expect(returnTo).toBe(`/autoriser?${query(params)}`);

      // le lien magique garde ce retour
      await http().post("/auth/magic-link").send({ email: "marie@client-a.fr", returnTo }).expect(204);
      const link = new URL(magicLinks(app).sent[0].link);
      expect(link.searchParams.get("returnTo")).toBe(returnTo);
    });

    it("refuse un retour vers un autre site dans le lien magique", async () => {
      await http().post("/auth/magic-link").send({ email: "marie@client-a.fr", returnTo: "https://pirate.fr" }).expect(204);
      expect(new URL(magicLinks(app).sent[0].link).searchParams.get("returnTo")).toBe("/");
    });

    it("envoie un utilisateur connecté directement vers l'autorisation", async () => {
      const { params } = validRequest();
      const marie = await loginAs(app, "marie@client-a.fr");
      const res = await marie.get(`/oauth/authorize?${query(params)}`).expect(302);
      expect(res.headers.location).toBe(`${FRONT}/autoriser?${query(params)}`);
    });
  });

  describe("choix du Site", () => {
    it("ne propose que les Sites des Clients de l'utilisateur dont le domaine correspond au retour", async () => {
      await givenSite(db, clientA, "autre-site-a.fr");
      const marie = await loginAs(app, "marie@client-a.fr");

      const res = await marie.get(`/oauth/consent?${query(validRequest().params)}`).expect(200);
      expect(res.body.sites).toEqual([{ id: siteA, domain: "site-a.fr", client: "Client A" }]);

      const forB = await marie.get(`/oauth/consent?${query(validRequest("site-b.fr").params)}`).expect(200);
      expect(forB.body.sites).toEqual([]);
    });

    it("exige une session (401)", async () => {
      await http().get(`/oauth/consent?${query(validRequest().params)}`).expect(401);
    });

    it("refuse un Site d'un autre Client (403)", async () => {
      const marie = await loginAs(app, "marie@client-a.fr");
      const res = await consent(marie, validRequest("site-b.fr").params, siteB).expect(403);
      expect(res.body.type).toBe("site-not-authorizable");
    });

    it("refuse un Site dont le domaine ne correspond pas à l'URL de retour (403)", async () => {
      await givenSite(db, clientA, "autre-site-a.fr");
      const marie = await loginAs(app, "marie@client-a.fr");
      await consent(marie, validRequest("autre-site-a.fr").params, siteA).expect(403);
    });

    it("ne renvoie pas un refus vers une URL qui ne mène à aucun Site connu (pas de redirection ouverte)", async () => {
      const marie = await loginAs(app, "marie@client-a.fr");
      const res = await marie.post("/oauth/consent").send({ ...validRequest("pirate.fr").params, decision: "deny" }).expect(400);
      expect(res.body.type).toBe("oauth-invalid-request");
    });

    it("l'agence peut autoriser n'importe quel Site", async () => {
      const alice = await loginAs(app, "alice@agence.fr");
      const res = await alice.get(`/oauth/consent?${query(validRequest("site-b.fr").params)}`).expect(200);
      expect(res.body.sites.map((s: { id: number }) => s.id)).toEqual([siteB]);
      await consent(alice, validRequest("site-b.fr").params, siteB).expect(200);
    });

    it("accepter renvoie vers le Plugin WP avec un code et le state", async () => {
      const marie = await loginAs(app, "marie@client-a.fr");
      const res = await consent(marie, validRequest().params, siteA).expect(200);

      const redirect = new URL(res.body.redirectTo);
      expect(redirect.origin + redirect.pathname).toBe("https://site-a.fr/wp-admin/admin.php");
      expect(redirect.searchParams.get("page")).toBe("manager-digital");
      expect(redirect.searchParams.get("code")).toBeTruthy();
      expect(redirect.searchParams.get("state")).toBe("etat-123");
    });

    it("refuser renvoie vers le Plugin WP avec access_denied, sans code", async () => {
      const marie = await loginAs(app, "marie@client-a.fr");
      const res = await marie.post("/oauth/consent").send({ ...validRequest().params, decision: "deny" }).expect(200);

      const redirect = new URL(res.body.redirectTo);
      expect(redirect.searchParams.get("error")).toBe("access_denied");
      expect(redirect.searchParams.get("state")).toBe("etat-123");
      expect(redirect.searchParams.get("code")).toBeNull();
    });
  });

  describe("échange du code", () => {
    it("délivre un jeton Bearer, stocké haché", async () => {
      const { code, verifier } = await codeForMarie();
      const res = await exchange(code, verifier).expect(200);

      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body).toMatchObject({ token_type: "Bearer" });
      const stored = await db.pluginAuthorization.findFirstOrThrow();
      expect(stored).toMatchObject({ user_id: ids.marie, site_id: siteA, revoked_at: null });
      expect(stored.token_hash).not.toContain(res.body.access_token);
    });

    it("le code est à usage unique", async () => {
      const { code, verifier } = await codeForMarie();
      await exchange(code, verifier).expect(200);

      const res = await exchange(code, verifier).expect(400);
      expect(res.body).toMatchObject({ type: "oauth-invalid-grant", error: "invalid_grant" });
    });

    it("le code expire vite", async () => {
      const { code, verifier } = await codeForMarie();
      const stored = await db.pluginAuthorizationCode.findFirstOrThrow();
      expect(stored.expires_at.getTime() - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000);

      await db.pluginAuthorizationCode.updateMany({ data: { expires_at: new Date(Date.now() - 1000) } });
      await exchange(code, verifier).expect(400);
    });

    it("refuse un mauvais vérificateur PKCE", async () => {
      const { code } = await codeForMarie();
      const res = await exchange(code, pkce().verifier).expect(400);
      expect(res.body.error).toBe("invalid_grant");
    });

    it("refuse une URL de retour différente de celle de la demande", async () => {
      const { code, verifier } = await codeForMarie();
      await exchange(code, verifier, "https://site-a.fr/autre-retour").expect(400);
    });

    it("refuse un autre grant_type", async () => {
      const res = await http().post("/oauth/token").type("form").send({ grant_type: "password" }).expect(400);
      expect(res.body.error).toBe("unsupported_grant_type");
    });

    it("une nouvelle autorisation du même Site par la même personne révoque la précédente", async () => {
      const first = await connectPlugin(app, "marie@client-a.fr", siteA, "site-a.fr");
      const second = await connectPlugin(app, "marie@client-a.fr", siteA, "site-a.fr");

      await asPlugin(app, first).get("/plugin/resources").expect(401);
      await asPlugin(app, second).get("/plugin/resources").expect(200);
    });
  });

  describe("routes du Plugin WP", () => {
    async function givenAttachedPage(externalId: string, siteId: number | null) {
      const integration = await db.integration.create({
        data: {
          provider: "META",
          external_user_id: `meta-${externalId}`,
          access_token: app.get(IntegrationsService).encrypt("user-token"),
          scopes: [],
          created_by_id: ids.alice,
          resources: {
            create: {
              access_token: app.get(IntegrationsService).encrypt("page-token"),
              resource: { create: { provider: "META", type: "FACEBOOK_PAGE", external_id: externalId, name: externalId, site_id: siteId } },
            },
          },
        },
      });
      return integration.id;
    }

    it("le parcours complet donne accès aux Ressources du Site, avec leur état et sans jeton Meta", async () => {
      await givenAttachedPage("page-a", siteA);
      const expired = await givenAttachedPage("page-a-expiree", siteA);
      await db.integration.update({ where: { id: expired }, data: { status: "EXPIRED" } });
      await givenAttachedPage("page-b", siteB);
      await givenAttachedPage("page-libre", null);

      const token = await connectPlugin(app, "marie@client-a.fr", siteA, "site-a.fr");
      const res = await asPlugin(app, token).get("/plugin/resources").expect(200);

      expect(res.body.map((r: { name: string; accessible: boolean }) => [r.name, r.accessible])).toEqual([
        ["page-a", true],
        ["page-a-expiree", false],
      ]);
      expect(JSON.stringify(res.body)).not.toContain("token");
    });

    it("exige social.read ou social.publish sur le Site du jeton (403)", async () => {
      await db.userFeature.deleteMany();
      const token = await connectPlugin(app, "marie@client-a.fr", siteA, "site-a.fr");

      const res = await asPlugin(app, token).get("/plugin/resources").expect(403);
      expect(res.body).toMatchObject({ type: "missing-feature", feature: "social.read" });
    });

    it("le Site vient toujours du jeton : un jeton du Site A ne donne jamais accès au Site B", async () => {
      await givenAttachedPage("page-b", siteB);
      const token = await connectPlugin(app, "marie@client-a.fr", siteA, "site-a.fr");

      const res = await asPlugin(app, token).get(`/plugin/resources?siteId=${siteB}`).expect(200);
      expect(res.body).toEqual([]);
    });

    it.each([
      ["sans jeton", undefined],
      ["avec un jeton inventé", "Bearer n-importe-quoi"],
      ["avec un autre schéma", "Basic abc"],
    ])("refuse une requête %s (401 Problem Details)", async (_, header) => {
      const req = http().get("/plugin/resources");
      const res = await (header ? req.set("Authorization", header) : req).expect(401).expect("Content-Type", /application\/problem\+json/);
      expect(res.body.type).toBe("plugin-token-invalid");
    });

    it("un cookie de session ne suffit pas", async () => {
      const marie = await loginAs(app, "marie@client-a.fr");
      await marie.get("/plugin/resources").expect(401);
    });

    it("un jeton n'ouvre aucune route de session", async () => {
      const token = await connectPlugin(app, "marie@client-a.fr", siteA, "site-a.fr");
      await http().get("/auth/me").set("Authorization", `Bearer ${token}`).expect(401);
    });

    it("refuse le jeton d'un utilisateur qui n'appartient plus au Client du Site", async () => {
      const token = await connectPlugin(app, "marie@client-a.fr", siteA, "site-a.fr");
      await db.userClient.deleteMany({ where: { user_id: ids.marie } });
      await asPlugin(app, token).get("/plugin/resources").expect(401);
    });
  });

  describe("révocation", () => {
    async function authorizationId() {
      return (await db.pluginAuthorization.findFirstOrThrow({ where: { revoked_at: null } })).id;
    }

    it("l'utilisateur liste et révoque ses autorisations", async () => {
      const token = await connectPlugin(app, "marie@client-a.fr", siteA, "site-a.fr");
      const marie = await loginAs(app, "marie@client-a.fr");

      const list = await marie.get("/oauth/authorizations").expect(200);
      expect(list.body).toEqual([expect.objectContaining({ site: { id: siteA, domain: "site-a.fr" } })]);
      expect(JSON.stringify(list.body)).not.toContain("token");

      await marie.delete(`/oauth/authorizations/${list.body[0].id}`).expect(204);
      const res = await asPlugin(app, token).get("/plugin/resources").expect(401);
      expect(res.body.type).toBe("plugin-token-invalid");
      expect((await marie.get("/oauth/authorizations").expect(200)).body).toEqual([]);
    });

    it("l'agence révoque l'autorisation de n'importe qui", async () => {
      const token = await connectPlugin(app, "marie@client-a.fr", siteA, "site-a.fr");
      const alice = await loginAs(app, "alice@agence.fr");

      const list = await alice.get("/oauth/authorizations").expect(200);
      expect(list.body.map((a: { user: { email: string } }) => a.user.email)).toEqual(["marie@client-a.fr"]);
      await alice.delete(`/oauth/authorizations/${await authorizationId()}`).expect(204);
      await asPlugin(app, token).get("/plugin/resources").expect(401);
    });

    it("un Utilisateur client ne révoque pas l'autorisation d'un autre (403)", async () => {
      await connectPlugin(app, "marie@client-a.fr", siteA, "site-a.fr");
      await db.user.create({ data: { email: "paul@client-a.fr", type: "CLIENT", clients: { create: { client_id: clientA } } } });
      const paul = await loginAs(app, "paul@client-a.fr");

      expect((await paul.get("/oauth/authorizations").expect(200)).body).toEqual([]);
      const res = await paul.delete(`/oauth/authorizations/${await authorizationId()}`).expect(403);
      expect(res.body.type).toBe("not-authorization-owner");
    });

    it("le Plugin WP révoque son propre jeton (RFC 7009)", async () => {
      const token = await connectPlugin(app, "marie@client-a.fr", siteA, "site-a.fr");

      await http().post("/oauth/revoke").type("form").send({ token }).expect(200);
      await asPlugin(app, token).get("/plugin/resources").expect(401);
      // un jeton inconnu ne trahit rien
      await http().post("/oauth/revoke").type("form").send({ token: "inconnu" }).expect(200);
    });
  });
});
