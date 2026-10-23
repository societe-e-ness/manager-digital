import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { DatabaseService } from "../src/core/database/database.service";
import { createTestApp, resetDatabase } from "./support/app";
import { loginAs } from "./support/auth";
import { CLIENT_ID, FakeAuthEness, ISSUER, RESOURCE } from "./support/fake-auth-eness";
import { assertNoUnexpectedCalls } from "./support/network";

const FRONT = "http://localhost:5173";
const TEN_MINUTES = 10 * 60 * 1000;

/** Un échec de callback renvoie le navigateur vers la page de connexion du front, avec le type d'erreur. */
function expectFrontError(res: { status: number; headers: Record<string, string> }, type: string) {
  expect(res.status).toBe(302);
  const url = new URL(res.headers.location);
  expect(`${url.origin}${url.pathname}`).toBe(`${FRONT}/connexion`);
  expect(url.searchParams.get("erreur")).toBe(type);
}

describe("Connexion SSO auth.eness (HTTP)", () => {
  let app: INestApplication;
  let db: DatabaseService;
  const auth = new FakeAuthEness();

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DatabaseService);
  });

  beforeEach(async () => {
    await resetDatabase(db);
    await auth.install();
    await db.user.create({ data: { email: "jeanne@eness.fr", name: "Jeanne", type: "AGENCY" } });
    await db.user.create({ data: { email: "marie@client-a.fr", name: "Marie", type: "CLIENT" } });
    auth.addAccount({ sub: "sub-jeanne", email: "jeanne@eness.fr", type: "staff" });
    auth.addAccount({ sub: "sub-marie", email: "marie@client-a.fr", type: "client" });
  });

  afterEach(() => {
    auth.uninstall();
    assertNoUnexpectedCalls();
  });

  afterAll(async () => {
    await app.close();
  });

  /** Le parcours complet du navigateur : aller, écran d'auth.eness, retour. */
  async function ssoLogin(sub: string, returnTo?: string) {
    const agent = request.agent(app.getHttpServer());
    const login = await agent.get("/auth/sso/login").query(returnTo ? { returnTo } : {}).expect(302);
    const callback = await agent.get(auth.approve(login.headers.location, sub));
    return { agent, login, callback };
  }

  describe("aller vers auth.eness", () => {
    it("redirige avec state, nonce, PKCE S256 et resource, sans demander de rôles", async () => {
      const res = await request(app.getHttpServer()).get("/auth/sso/login").expect(302);

      const url = new URL(res.headers.location);
      expect(`${url.origin}${url.pathname}`).toBe(`${ISSUER}/auth`);
      expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
      expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/auth/sso/callback");
      expect(url.searchParams.get("scope")?.split(" ")).toEqual(expect.arrayContaining(["openid", "email"]));
      expect(url.searchParams.get("scope")?.split(" ")).not.toContain("roles");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("code_challenge")).toBeTruthy();
      expect(url.searchParams.get("state")).toBeTruthy();
      expect(url.searchParams.get("nonce")).toBeTruthy();
      expect(url.searchParams.get("resource")).toBe(RESOURCE);
      expect(res.headers["set-cookie"]?.[0]).toMatch(/HttpOnly/i);
    });
  });

  describe("retour d'auth.eness", () => {
    it("ouvre une session SSO, enregistre le sub et renvoie vers le front", async () => {
      const { agent, callback } = await ssoLogin("sub-jeanne", "/integrations");

      expect(callback.status).toBe(302);
      expect(callback.headers.location).toBe(`${FRONT}/integrations`);

      const me = await agent.get("/auth/me").expect(200);
      expect(me.body).toMatchObject({ email: "jeanne@eness.fr", type: "AGENCY" });

      const jeanne = await db.user.findUniqueOrThrow({ where: { email: "jeanne@eness.fr" } });
      expect(jeanne.sso_subject).toBe("sub-jeanne");
      const [session] = await db.session.findMany();
      expect(session.method).toBe("SSO");
      expect(session.refresh_token).not.toBeNull();
    });

    it("connecte aussi un Utilisateur client", async () => {
      const { agent } = await ssoLogin("sub-marie");
      const me = await agent.get("/auth/me").expect(200);
      expect(me.body).toMatchObject({ email: "marie@client-a.fr", type: "CLIENT" });
    });

    it("retrouve ensuite la personne par son sub, même si son email a changé", async () => {
      await ssoLogin("sub-jeanne");
      auth.accounts.get("sub-jeanne")!.email = "jeanne.martin@eness.fr";

      const { agent } = await ssoLogin("sub-jeanne");

      const me = await agent.get("/auth/me").expect(200);
      expect(me.body.email).toBe("jeanne@eness.fr");
    });

    it("garde le type défini dans le Manager Digital, même si auth.eness dit autre chose", async () => {
      auth.accounts.get("sub-marie")!.type = "staff";
      const { agent } = await ssoLogin("sub-marie");
      expect((await agent.get("/auth/me").expect(200)).body.type).toBe("CLIENT");
    });

    it("refuse un compte auth.eness inconnu du Manager Digital, sans créer de compte", async () => {
      auth.addAccount({ sub: "sub-inconnu", email: "inconnu@eness.fr" });

      const { callback } = await ssoLogin("sub-inconnu");

      expectFrontError(callback, "sso-unknown-user");
      expect(await db.user.count()).toBe(2);
      expect(await db.session.count()).toBe(0);
    });

    it("ne rattache pas un compte par un email non vérifié par auth.eness", async () => {
      auth.accounts.get("sub-jeanne")!.emailVerified = false;

      const { callback } = await ssoLogin("sub-jeanne");

      expectFrontError(callback, "sso-unknown-user");
      expect((await db.user.findUniqueOrThrow({ where: { email: "jeanne@eness.fr" } })).sso_subject).toBeNull();
    });

    it("ne rattache pas un email déjà lié à un autre compte auth.eness", async () => {
      await db.user.update({ where: { email: "jeanne@eness.fr" }, data: { sso_subject: "autre-sub" } });

      const { callback } = await ssoLogin("sub-jeanne");

      expectFrontError(callback, "sso-unknown-user");
    });


    it.each(["//evil.example", "https://evil.example/", "javascript:alert(1)"])(
      "ignore un returnTo qui n'est pas un chemin local (%s)",
      async (returnTo) => {
        const { callback } = await ssoLogin("sub-jeanne", returnTo);
        expect(callback.headers.location).toBe(`${FRONT}/`);
      },
    );

    it("refuse un state falsifié", async () => {
      const agent = request.agent(app.getHttpServer());
      const login = await agent.get("/auth/sso/login").expect(302);
      const path = auth.approve(login.headers.location, "sub-jeanne").replace(/state=[^&]+/, "state=falsifie");

      expectFrontError(await agent.get(path), "sso-failed");
      expect(await db.session.count()).toBe(0);
    });

    it("refuse un retour sans aller (pas de cookie de connexion en cours)", async () => {
      const login = await request(app.getHttpServer()).get("/auth/sso/login").expect(302);
      const res = await request(app.getHttpServer()).get(auth.approve(login.headers.location, "sub-jeanne"));
      expectFrontError(res, "sso-flow-missing");
    });
  });

  describe("revérification auprès d'auth.eness", () => {
    async function ageCheck() {
      await db.session.updateMany({ data: { checked_at: new Date(Date.now() - TEN_MINUTES - 1000) } });
    }

    it("après 10 minutes, confirme l'accès auprès d'auth.eness", async () => {
      const { agent } = await ssoLogin("sub-jeanne");
      const before = auth.tokenRequests;
      await ageCheck();

      await agent.get("/auth/me").expect(200);

      expect(auth.tokenRequests).toBe(before + 1);
      expect((await db.session.findFirstOrThrow()).checked_at!.getTime()).toBeGreaterThan(Date.now() - 5000);
    });

    it("ne redemande rien à auth.eness avant 10 minutes", async () => {
      const { agent } = await ssoLogin("sub-jeanne");
      const before = auth.tokenRequests;

      await agent.get("/auth/me").expect(200);

      expect(auth.tokenRequests).toBe(before);
    });


    it("après 10 minutes, coupe la session si l'accès a été retiré", async () => {
      const { agent } = await ssoLogin("sub-jeanne");
      auth.accounts.get("sub-jeanne")!.hasAccess = false;
      await ageCheck();

      const res = await agent.get("/auth/me").expect(401);

      expect(res.body.type).toBe("unauthenticated");
      expect((await db.session.findFirstOrThrow()).revoked_at).not.toBeNull();
    });

    it("révoque aussi les Plugin WP autorisés par la personne quand l'accès a été retiré", async () => {
      const { agent } = await ssoLogin("sub-jeanne");
      const jeanne = await db.user.findUniqueOrThrow({ where: { sso_subject: "sub-jeanne" } });
      const client = await db.client.create({ data: { name: "Client" } });
      const site = await db.site.create({ data: { domain: "site.fr", client_id: client.id } });
      await db.pluginAuthorization.create({ data: { user_id: jeanne.id, site_id: site.id, token_hash: "empreinte" } });
      auth.accounts.get("sub-jeanne")!.hasAccess = false;
      await ageCheck();

      await agent.get("/auth/me").expect(401);

      expect((await db.pluginAuthorization.findFirstOrThrow()).revoked_at).not.toBeNull();
    });

    it("ne déconnecte pas pour une panne d'auth.eness, et revérifie plus tard", async () => {
      const { agent } = await ssoLogin("sub-jeanne");
      auth.down = true;
      await ageCheck();

      await agent.get("/auth/me").expect(200);

      expect((await db.session.findFirstOrThrow()).revoked_at).toBeNull();
    });

    it("ne revérifie pas les sessions par lien magique", async () => {
      const agent = await loginAs(app, "jeanne@eness.fr");
      await ageCheck();

      await agent.get("/auth/me").expect(200);
      expect(auth.tokenRequests).toBe(0);
    });
  });

  describe("déconnexion", () => {
    it("une session SSO renvoie l'URL de fin de session d'auth.eness", async () => {
      const { agent } = await ssoLogin("sub-jeanne");

      const res = await agent.post("/auth/logout").expect(200);

      const url = new URL(res.body.logoutUrl);
      expect(`${url.origin}${url.pathname}`).toBe(`${ISSUER}/session/end`);
      expect(url.searchParams.get("id_token_hint")).toBeTruthy();
      expect(url.searchParams.get("post_logout_redirect_uri")).toBe(`${FRONT}/`);
      await agent.get("/auth/me").expect(401);
    });

    it("le back-channel révoque les sessions de la session SSO concernée", async () => {
      const { agent: jeanne } = await ssoLogin("sub-jeanne");
      const { agent: marie } = await ssoLogin("sub-marie");

      await request(app.getHttpServer())
        .post("/auth/sso/backchannel")
        .type("form")
        .send({ logout_token: await auth.logoutToken({ sid: "sid-sub-jeanne" }) })
        .expect(200);

      await jeanne.get("/auth/me").expect(401);
      await marie.get("/auth/me").expect(200);
    });

    it("le back-channel par sub révoque toutes les sessions SSO de la personne", async () => {
      const { agent: first } = await ssoLogin("sub-jeanne");
      const { agent: second } = await ssoLogin("sub-jeanne");

      await request(app.getHttpServer())
        .post("/auth/sso/backchannel")
        .type("form")
        .send({ logout_token: await auth.logoutToken({ sub: "sub-jeanne" }) })
        .expect(200);

      await first.get("/auth/me").expect(401);
      await second.get("/auth/me").expect(401);
    });

    it("le back-channel refuse un jeton mal signé", async () => {
      const { agent } = await ssoLogin("sub-jeanne");

      await request(app.getHttpServer())
        .post("/auth/sso/backchannel")
        .type("form")
        .send({ logout_token: await auth.logoutToken({ sid: "sid-sub-jeanne" }, { forged: true }) })
        .expect(400);

      await agent.get("/auth/me").expect(200);
    });
  });
});
