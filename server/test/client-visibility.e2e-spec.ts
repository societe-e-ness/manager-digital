import type { INestApplication } from "@nestjs/common";
import type TestAgent from "supertest/lib/agent";
import { DatabaseService } from "../src/core/database/database.service";
import { IntegrationsService } from "../src/core/integrations/integrations.service";
import { createTestApp, resetDatabase } from "./support/app";
import { loginAs } from "./support/auth";
import { FakeGraph } from "./support/fake-graph";
import { givenOverride, givenSite } from "./support/rights";

/**
 * Rattachement et visibilité selon le Client, avec un Utilisateur agence (Alice) et deux
 * Utilisateurs client : Marie (Client A) et Bob (Client B). Tous ont social.manage partout
 * où ils ont accès : seule l'appartenance au Client les distingue.
 *
 *   Intégration de l'agence (Alice) → page-agence
 *   Intégration du Client A (Marie) → page-a, page-partagee
 *   Intégration du Client B (Bob)   → page-b, page-partagee
 */
const FRONT = "http://localhost:5173";

describe("Rattachement et visibilité selon le Client (HTTP)", () => {
  let app: INestApplication;
  let db: DatabaseService;
  const graph = new FakeGraph();

  let clientA: number;
  let clientB: number;
  let siteA: number;
  let siteB: number;
  let alice: TestAgent;
  let marie: TestAgent;
  let bob: TestAgent;
  let ids: { alice: number; marie: number; bob: number };
  let integrations: { agence: number; a: number; b: number };

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DatabaseService);
  });

  beforeEach(async () => {
    await resetDatabase(db);
    graph.install();
    clientA = (await db.client.create({ data: { name: "Client A" } })).id;
    clientB = (await db.client.create({ data: { name: "Client B" } })).id;
    siteA = (await givenSite(db, clientA, "site-a.fr", ["social.manage"])).id;
    siteB = (await givenSite(db, clientB, "site-b.fr", ["social.manage"])).id;

    ids = {
      alice: await user("alice@agence.fr", "AGENCY", []),
      marie: await user("marie@client-a.fr", "CLIENT", [clientA]),
      bob: await user("bob@client-b.fr", "CLIENT", [clientB]),
    };
    alice = await loginAs(app, "alice@agence.fr");
    marie = await loginAs(app, "marie@client-a.fr");
    bob = await loginAs(app, "bob@client-b.fr");

    integrations = {
      agence: await givenIntegration(ids.alice, null, "meta-alice", ["page-agence"]),
      a: await givenIntegration(ids.marie, clientA, "meta-marie", ["page-a", "page-partagee"]),
      b: await givenIntegration(ids.bob, clientB, "meta-bob", ["page-b", "page-partagee"]),
    };
  });

  afterEach(() => {
    graph.uninstall();
    graph.assertNoUnexpectedCalls();
  });

  afterAll(async () => {
    await app.close();
  });

  /** Un utilisateur avec social.manage sur tous ses Sites. */
  async function user(email: string, type: "AGENCY" | "CLIENT", clientIds: number[]) {
    const { id } = await db.user.create({
      data: { email, type, clients: { create: clientIds.map((client_id) => ({ client_id })) } },
    });
    await givenOverride(db, id, "social.manage", "ADD");
    return id;
  }

  /** Une Intégration Meta et les pages auxquelles elle mène (une page déjà connue est partagée). */
  async function givenIntegration(createdBy: number, clientId: number | null, externalUserId: string, pages: string[]) {
    const integration = await db.integration.create({
      data: {
        provider: "META",
        external_user_id: externalUserId,
        access_token: app.get(IntegrationsService).encrypt(`token-${externalUserId}`),
        scopes: [],
        client_id: clientId,
        created_by_id: createdBy,
        resources: {
          create: pages.map((external_id) => ({
            resource: {
              connectOrCreate: {
                where: { provider_type_external_id: { provider: "META", type: "FACEBOOK_PAGE", external_id } },
                create: { provider: "META", type: "FACEBOOK_PAGE", external_id, name: external_id },
              },
            },
          })),
        },
      },
    });
    return integration.id;
  }

  async function resource(externalId: string) {
    return (await db.resource.findFirstOrThrow({ where: { external_id: externalId } })).id;
  }

  /** Rattache (ou détache avec null) et vérifie le statut HTTP. */
  const attach = async (agent: TestAgent, externalId: string, siteId: number | null, status: number) =>
    agent.patch(`/integrations/resources/${await resource(externalId)}`).send({ siteId }).expect(status);

  async function visibleNames(agent: TestAgent, clientId?: number) {
    const res = await agent.get(`/integrations/resources${clientId ? `?clientId=${clientId}` : ""}`).expect(200);
    expect(JSON.stringify(res.body)).not.toContain("token");
    return (res.body as { name: string }[]).map((r) => r.name).sort();
  }

  describe("rattachement", () => {
    it("un Utilisateur client rattache une Ressource de son Intégration à un Site de son Client", async () => {
      const res = await attach(marie, "page-a", siteA, 200);
      expect(res.body).toMatchObject({ name: "page-a", site_id: siteA, accessible: true });
    });

    it("un Utilisateur client ne peut pas rattacher une Ressource à un Site d'un autre Client (403)", async () => {
      const res = await attach(marie, "page-a", siteB, 403);
      expect(res.body.type).toBe("missing-feature");
    });

    it("un Utilisateur client ne peut pas prendre une Ressource atteinte seulement par l'Intégration d'un autre", async () => {
      await attach(marie, "page-b", siteA, 403);
      await attach(marie, "page-agence", siteA, 403);
      expect(await db.resource.count({ where: { site_id: { not: null } } })).toBe(0);
    });

    it("une Ressource déjà rattachée à un autre Site ne se rattache pas sans détachement préalable (409)", async () => {
      await attach(bob, "page-partagee", siteB, 200);

      const res = await attach(marie, "page-partagee", siteA, 409);
      expect(res.body).toMatchObject({ type: "resource-already-attached", status: 409 });
      expect((await db.resource.findFirstOrThrow({ where: { external_id: "page-partagee" } })).site_id).toBe(siteB);

      await attach(bob, "page-partagee", null, 200);
      await attach(marie, "page-partagee", siteA, 200);
    });

    it("rattacher de nouveau au même Site ne change rien", async () => {
      await attach(marie, "page-a", siteA, 200);
      await attach(marie, "page-a", siteA, 200);
    });

    it("même l'agence ne rattache pas au Site d'un Client une page atteinte seulement par un autre Client", async () => {
      const res = await attach(alice, "page-a", siteB, 403);
      expect(res.body.type).toBe("resource-not-reachable");
    });

    it("l'agence rattache une Ressource de son Intégration au Site d'un Client", async () => {
      await attach(alice, "page-agence", siteA, 200);
    });
  });

  describe("visibilité", () => {
    it("un Utilisateur client voit une Ressource connectée par l'agence dès qu'elle est rattachée à un Site de son Client", async () => {
      expect(await visibleNames(marie, clientA)).toEqual(["page-a", "page-partagee"]);

      await attach(alice, "page-agence", siteA, 200);

      expect(await visibleNames(marie, clientA)).toEqual(["page-a", "page-agence", "page-partagee"]);
      expect(await visibleNames(bob, clientB)).toEqual(["page-b", "page-partagee"]);
    });

    it("un Utilisateur client ne voit ni les Ressources ni les Intégrations des autres Clients", async () => {
      await attach(bob, "page-partagee", siteB, 200);

      expect(await visibleNames(marie, clientA)).toEqual(["page-a"]);
      await marie.get(`/integrations/resources?clientId=${clientB}`).expect(403);
      await marie.get("/integrations/resources").expect(403);
      await marie.get(`/integrations?clientId=${clientB}`).expect(403);
      await marie.get(`/integrations/${integrations.b}`).expect(403);
      await marie.get(`/integrations/${integrations.agence}`).expect(403);

      // Son Intégration mène à la page partagée, mais elle ne voit pas le Site de B
      const res = await marie.get(`/integrations/${integrations.a}`).expect(200);
      const partagee = res.body.resources.find((r: { name: string }) => r.name === "page-partagee");
      expect(partagee).toMatchObject({ site_id: null, attached_elsewhere: true });
      expect(JSON.stringify(res.body)).not.toContain(`"site_id":${siteB}`);
    });

    it("l'agence voit toutes les Ressources", async () => {
      await attach(bob, "page-partagee", siteB, 200);
      expect(await visibleNames(alice)).toEqual(["page-a", "page-agence", "page-b", "page-partagee"]);

      const res = await alice.get(`/integrations/${integrations.a}`).expect(200);
      const partagee = res.body.resources.find((r: { name: string }) => r.name === "page-partagee");
      expect(partagee).toMatchObject({ site_id: siteB, attached_elsewhere: false });
    });
  });

  describe("déconnexion", () => {
    it("un Utilisateur client déconnecte sa propre Intégration", async () => {
      await marie.delete(`/integrations/${integrations.a}`).expect(204);
      expect(await db.integration.count({ where: { id: integrations.a } })).toBe(0);
    });

    it("un Utilisateur client ne déconnecte pas l'Intégration de l'agence (403)", async () => {
      await marie.delete(`/integrations/${integrations.agence}`).expect(403);
      expect(await db.integration.count({ where: { id: integrations.agence } })).toBe(1);
    });

    it("un Utilisateur client ne déconnecte pas l'Intégration d'un collègue du même Client (403)", async () => {
      await user("paul@client-a.fr", "CLIENT", [clientA]);
      const paul = await loginAs(app, "paul@client-a.fr");

      const res = await paul.delete(`/integrations/${integrations.a}`).expect(403);
      expect(res.body.type).toBe("not-integration-owner");
      expect(await db.integration.count({ where: { id: integrations.a } })).toBe(1);
    });

    it("un Utilisateur agence déconnecte n'importe quelle Intégration", async () => {
      await alice.delete(`/integrations/${integrations.b}`).expect(204);
      await alice.delete(`/integrations/${integrations.a}`).expect(204);
      expect(await db.integration.count()).toBe(1);
    });
  });

  describe("connexion d'un compte Meta", () => {
    /** Le vrai parcours : départ vers Meta, puis retour avec un code, Meta simulé. */
    async function connectMeta(agent: TestAgent, clientId: number, metaUserId: string) {
      const started = await agent.get(`/integrations/oauth/connect?clientId=${clientId}`).expect(302);
      const state = new URL(started.headers.location).searchParams.get("state")!;

      graph.reset();
      graph.on("GET", "/oauth/access_token", { access_token: `token-${metaUserId}`, expires_in: 5184000 });
      graph.on("GET", "/me", { id: metaUserId, name: "Personne Meta" });
      graph.on("GET", "/me/permissions", { data: [{ permission: "pages_show_list", status: "granted" }] });
      graph.on("GET", "/me/adaccounts", { data: [] });
      graph.on("GET", "/me/accounts", { data: [{ id: "page-commune", name: "Page commune", access_token: "page-token" }] });

      // retour vers la page de gestion du front, pour ce Client
      const res = await agent.get(`/integrations/oauth/callback?code=abc&state=${state}`).expect(302);
      const back = new URL(res.headers.location);
      expect(back.origin + back.pathname).toBe(`${FRONT}/reseaux-sociaux`);
      expect(back.searchParams.get("clientId")).toBe(String(clientId));
      expect(back.searchParams.get("connexion")).toBe("ok");
      expect(res.headers.location).not.toContain("token");
      return db.integration.findFirstOrThrow({ where: { external_user_id: metaUserId, client_id: clientId } });
    }

    /** Départ vers Meta pour ce Client : le state signé que Meta renverra. */
    async function startConnection(agent: TestAgent, clientId: number) {
      const started = await agent.get(`/integrations/oauth/connect?clientId=${clientId}`).expect(302);
      return new URL(started.headers.location).searchParams.get("state")!;
    }

    function expectBackWithError(location: string, type: string) {
      const back = new URL(location);
      expect(back.origin + back.pathname).toBe(`${FRONT}/reseaux-sociaux`);
      expect(back.searchParams.get("clientId")).toBe(String(clientA));
      expect(back.searchParams.get("erreur")).toBe(type);
      expect(back.searchParams.get("connexion")).toBeNull();
    }

    it("un consentement refusé chez Meta ramène vers la page avec une erreur explicite", async () => {
      const state = await startConnection(marie, clientA);

      const res = await marie.get(`/integrations/oauth/callback?error=access_denied&state=${state}`).expect(302);

      expectBackWithError(res.headers.location, "meta-consent-refused");
      expect(graph.calls).toHaveLength(0);
    });

    it("un droit retiré pendant la connexion ramène vers la page avec l'erreur, sans appeler Meta", async () => {
      const state = await startConnection(marie, clientA);
      await db.userFeature.deleteMany({ where: { user_id: ids.marie } });

      const res = await marie.get(`/integrations/oauth/callback?code=abc&state=${state}`).expect(302);

      expectBackWithError(res.headers.location, "missing-feature");
      expect(graph.calls).toHaveLength(0);
    });

    it("la liste des Intégrations dit qui les a connectées", async () => {
      const res = await marie.get(`/integrations?clientId=${clientA}`).expect(200);
      expect(res.body.map((i: { created_by: unknown }) => i.created_by)).toEqual([
        { id: ids.marie, email: "marie@client-a.fr", name: null },
      ]);
    });

    it("le même compte Meta connecté pour deux Clients donne deux Intégrations, sans toucher à celle de l'autre", async () => {
      const forA = await connectMeta(marie, clientA, "meta-freelance");
      const forB = await connectMeta(bob, clientB, "meta-freelance");

      expect(forB.id).not.toBe(forA.id);
      expect(forA).toMatchObject({ client_id: clientA, created_by_id: ids.marie });
      expect(forB).toMatchObject({ client_id: clientB, created_by_id: ids.bob });
      expect(await db.resource.count({ where: { external_id: "page-commune" } })).toBe(1);

      // une reconnexion pour le même Client met à jour l'Intégration existante
      const again = await connectMeta(marie, clientA, "meta-freelance");
      expect(again.id).toBe(forA.id);
      expect(await db.integration.count({ where: { external_user_id: "meta-freelance" } })).toBe(2);
    });

    it("la personne qui reconnecte un compte devient celle qui peut le déconnecter", async () => {
      const first = await connectMeta(marie, clientA, "meta-partage");
      await user("paul@client-a.fr", "CLIENT", [clientA]);
      const paul = await loginAs(app, "paul@client-a.fr");

      const again = await connectMeta(paul, clientA, "meta-partage");

      expect(again.id).toBe(first.id);
      await marie.delete(`/integrations/${first.id}`).expect(403);
      await paul.delete(`/integrations/${first.id}`).expect(204);
    });
  });
});
