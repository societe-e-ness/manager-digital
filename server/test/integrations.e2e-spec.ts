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
  const graph = new FakeGraph();

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DatabaseService);
  });

  beforeEach(async () => {
    await resetDatabase(db);
    agencyUserId = (await db.user.create({ data: { email: "agence@test.fr", type: "AGENCY" } })).id;
    await givenFeatureOnOwnSite(db, agencyUserId, "social.manage");
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
  async function givenIntegration() {
    return db.integration.create({
      data: {
        provider: "META",
        external_user_id: "meta-user-1",
        access_token: app.get(IntegrationsService).encrypt("user-token"),
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
});
