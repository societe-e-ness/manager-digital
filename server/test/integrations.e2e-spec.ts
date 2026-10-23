import type { INestApplication } from "@nestjs/common";
import type TestAgent from "supertest/lib/agent";
import { DatabaseService } from "../src/core/database/database.service";
import { IntegrationsService } from "../src/core/integrations/integrations.service";
import { createTestApp, resetDatabase } from "./support/app";
import { loginAs } from "./support/auth";
import { FakeGraph } from "./support/fake-graph";
import { givenFeatureOnOwnSite } from "./support/rights";

describe("Intégrations (HTTP)", () => {
  let app: INestApplication;
  let db: DatabaseService;
  let agency: TestAgent;
  let agencyUserId: number;
  let siteId: number; // un Site sur lequel l'agence a social.manage
  const graph = new FakeGraph();

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DatabaseService);
  });

  beforeEach(async () => {
    await resetDatabase(db);
    agencyUserId = (await db.user.create({ data: { email: "agence@test.fr", type: "AGENCY" } })).id;
    siteId = (await givenFeatureOnOwnSite(db, agencyUserId, "social.manage")).id;
    agency = await loginAs(app, "agence@test.fr");
    graph.install();
  });

  afterEach(() => {
    graph.uninstall();
    graph.assertNoUnexpectedCalls();
  });

  afterAll(async () => {
    await app.close();
  });

  /** Une Intégration Meta en base, avec un jeton chiffré comme en vrai. */
  async function givenIntegration(externalUserId = "meta-user-1", userToken = "user-token") {
    return db.integration.create({
      data: {
        provider: "META",
        external_user_id: externalUserId,
        access_token: app.get(IntegrationsService).encrypt(userToken),
        expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        scopes: ["pages_show_list"],
        created_by_id: agencyUserId,
      },
    });
  }

  it("une Intégration introuvable renvoie un Problem Details 404 au type stable", async () => {
    const res = await agency
      .get("/integrations/999")
      .expect(404)
      .expect("Content-Type", /application\/problem\+json/);

    expect(res.body).toEqual({
      type: "integration-not-found",
      title: "Intégration introuvable",
      status: 404,
      detail: "Intégration 999 introuvable",
    });
  });

  it("une erreur de validation sans type dédié reste au format Problem Details", async () => {
    const res = await agency
      .get("/integrations/abc")
      .expect(400)
      .expect("Content-Type", /application\/problem\+json/);

    expect(res.body).toMatchObject({ type: "about:blank", title: "Bad Request", status: 400 });
    expect(typeof res.body.detail).toBe("string");
  });

  it("la synchronisation des Ressources passe par le faux Graph Meta", async () => {
    const integration = await givenIntegration();
    graph.on("GET", "/me/adaccounts", { data: [] });
    graph.on("GET", "/me/accounts", {
      data: [
        {
          id: "page-1",
          name: "Boulangerie Martin",
          access_token: "page-token",
          category: "Boulangerie",
          instagram_business_account: { id: "ig-1", username: "boulangerie.martin" },
        },
      ],
    });

    const res = await agency.post(`/integrations/${integration.id}/resources/sync`).expect(201);

    expect(res.body.resources.map((r: { type: string; name: string }) => [r.type, r.name])).toEqual(
      expect.arrayContaining([
        ["FACEBOOK_PAGE", "Boulangerie Martin"],
        ["INSTAGRAM_ACCOUNT", "boulangerie.martin"],
      ]),
    );
    expect(JSON.stringify(res.body)).not.toContain("token");
    expect(graph.calls.map((c) => c.path)).toEqual(["/me/adaccounts", "/me/accounts"]);
    expect(graph.calls[0].query.get("access_token")).toBe("user-token");
  });

  describe("une page = une Ressource", () => {
    interface PublicResource {
      id: number;
      type: string;
      name: string;
      site_id: number | null;
      parent_id: number | null;
      accessible: boolean;
    }

    interface FakePage {
      id: string;
      name?: string;
      token: string;
      instagram?: string;
    }

    /** Ce que Meta renverra à la prochaine synchronisation : ces pages, aucun compte publicitaire. */
    function metaReturnsPages(...pages: FakePage[]) {
      graph.reset().on("GET", "/me/adaccounts", { data: [] });
      graph.on("GET", "/me/accounts", {
        data: pages.map((p) => ({
          id: p.id,
          name: p.name ?? `Page ${p.id}`,
          access_token: p.token,
          category: "Commerce",
          ...(p.instagram ? { instagram_business_account: { id: p.instagram, username: `ig.${p.instagram}` } } : {}),
        })),
      });
    }

    async function sync(integrationId: number, ...pages: FakePage[]) {
      metaReturnsPages(...pages);
      const res = await agency.post(`/integrations/${integrationId}/resources/sync`).expect(201);
      expect(JSON.stringify(res.body)).not.toContain("token");
      return res.body.resources as PublicResource[];
    }

    async function resourcesOf(integrationId: number) {
      const res = await agency.get(`/integrations/${integrationId}`).expect(200);
      expect(JSON.stringify(res.body)).not.toContain("token");
      return res.body.resources as PublicResource[];
    }

    const page = (resources: PublicResource[], name?: string) =>
      resources.find((r) => r.type === "FACEBOOK_PAGE" && (!name || r.name === name))!;

    it("deux comptes Meta qui ont accès à la même page produisent une seule Ressource, reliée aux deux", async () => {
      const a = await givenIntegration("meta-a", "user-token-a");
      const b = await givenIntegration("meta-b", "user-token-b");

      const viaA = await sync(a.id, { id: "page-1", token: "page-token-a", instagram: "ig-1" });
      const viaB = await sync(b.id, { id: "page-1", token: "page-token-b", instagram: "ig-1" });

      expect(viaB.map((r) => r.id).sort()).toEqual(viaA.map((r) => r.id).sort());
      expect(await db.resource.count()).toBe(2); // la page et son compte Instagram
      const instagram = viaA.find((r) => r.type === "INSTAGRAM_ACCOUNT")!;
      expect(instagram.parent_id).toBe(page(viaA).id);

      // chaque lien garde le jeton de page obtenu au travers de son Intégration
      const links = await db.integrationResource.findMany({
        where: { resource_id: page(viaA).id },
        orderBy: { integration_id: "asc" },
      });
      const integrations = app.get(IntegrationsService);
      expect(links.map((l) => integrations.decrypt(l.access_token!))).toEqual(["page-token-a", "page-token-b"]);
    });

    it("re-synchroniser met à jour les Ressources existantes, sans doublon", async () => {
      const a = await givenIntegration();
      const first = await sync(a.id, { id: "page-1", name: "Boulangerie Martin", token: "t1" });
      const second = await sync(a.id, { id: "page-1", name: "Boulangerie Martin & Fils", token: "t2" });

      expect(second).toHaveLength(1);
      expect(page(second)).toMatchObject({ id: page(first).id, name: "Boulangerie Martin & Fils" });
      expect(await db.resource.count()).toBe(1);
    });

    it("re-synchroniser oublie une page que l'Intégration n'atteint plus", async () => {
      const a = await givenIntegration();
      await sync(a.id, { id: "page-1", token: "t1" }, { id: "page-2", token: "t2" });
      const after = await sync(a.id, { id: "page-1", token: "t1" });

      expect(after.map((r) => r.name)).toEqual(["Page page-1"]);
      expect(await db.resource.count()).toBe(1);
    });

    it("suit la pagination de Meta : une page au-delà de la première réponse n'est pas oubliée", async () => {
      const a = await givenIntegration();
      graph.reset().on("GET", "/me/adaccounts", { data: [] });
      graph.on("GET", "/me/accounts", { data: [{ id: "page-2", name: "Deuxième", access_token: "t2" }] }, 200, { after: "c1" });
      graph.on("GET", "/me/accounts", {
        data: [{ id: "page-1", name: "Première", access_token: "t1" }],
        paging: { cursors: { after: "c1" }, next: "https://graph.facebook.com/v21.0/me/accounts?after=c1" },
      });

      const res = await agency.post(`/integrations/${a.id}/resources/sync`).expect(201);

      expect(res.body.resources.map((r: PublicResource) => r.name)).toEqual(["Première", "Deuxième"]);
      expect(graph.calls.filter((c) => c.path === "/me/accounts").map((c) => c.query.get("after"))).toEqual([null, "c1"]);
    });

    it("le rattachement à un Site est porté par la Ressource, quelle que soit l'Intégration", async () => {
      const a = await givenIntegration("meta-a");
      const b = await givenIntegration("meta-b");
      const viaA = await sync(a.id, { id: "page-1", token: "t1" });
      await agency.patch(`/integrations/resources/${page(viaA).id}`).send({ siteId }).expect(200);

      const viaB = await sync(b.id, { id: "page-1", token: "t2" });
      expect(page(viaB).site_id).toBe(siteId);
      expect(page(await sync(a.id, { id: "page-1", token: "t1" })).site_id).toBe(siteId);
    });

    it("déconnecter une Intégration garde une Ressource encore atteignable par une autre, avec son rattachement", async () => {
      const a = await givenIntegration("meta-a");
      const b = await givenIntegration("meta-b");
      const viaA = await sync(a.id, { id: "page-1", token: "t1" });
      await sync(b.id, { id: "page-1", token: "t2" });
      await agency.patch(`/integrations/resources/${page(viaA).id}`).send({ siteId }).expect(200);

      await agency.delete(`/integrations/${a.id}`).expect(204);

      expect(page(await resourcesOf(b.id))).toMatchObject({ id: page(viaA).id, site_id: siteId, accessible: true });
      expect(await db.integrationResource.count()).toBe(1);
    });

    it("déconnecter la dernière Intégration supprime une Ressource non référencée, garde inaccessible une Ressource rattachée", async () => {
      const a = await givenIntegration();
      const viaA = await sync(
        a.id,
        { id: "page-1", name: "Rattachée", token: "t1", instagram: "ig-1" },
        { id: "page-2", name: "Libre", token: "t2" },
      );
      const instagram = viaA.find((r) => r.type === "INSTAGRAM_ACCOUNT")!;
      await agency.patch(`/integrations/resources/${page(viaA, "Rattachée").id}`).send({ siteId }).expect(200);
      await agency.patch(`/integrations/resources/${instagram.id}`).send({ siteId }).expect(200);

      await agency.delete(`/integrations/${a.id}`).expect(204);

      const kept = await db.resource.findMany({ orderBy: { id: "asc" } });
      expect(kept.map((r) => [r.external_id, r.site_id])).toEqual([
        ["page-1", siteId],
        ["ig-1", siteId],
      ]);
      const res = await agency.patch(`/integrations/resources/${instagram.id}`).send({ siteId }).expect(200);
      expect(res.body).toMatchObject({ site_id: siteId, accessible: false });
      expect(JSON.stringify(res.body)).not.toContain("token");
    });

    it("une Ressource dont toutes les Intégrations sont expirées ou révoquées est inaccessible", async () => {
      const a = await givenIntegration("meta-a");
      const b = await givenIntegration("meta-b");
      await sync(a.id, { id: "page-1", token: "t1" });
      await sync(b.id, { id: "page-1", token: "t2" });

      await db.integration.update({ where: { id: a.id }, data: { status: "EXPIRED" } });
      expect(page(await resourcesOf(a.id)).accessible).toBe(true); // B y mène encore

      await db.integration.update({ where: { id: b.id }, data: { status: "REVOKED" } });
      expect(page(await resourcesOf(a.id)).accessible).toBe(false);
      expect(page(await resourcesOf(b.id)).accessible).toBe(false);
    });
  });
});
