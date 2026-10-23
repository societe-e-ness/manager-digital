import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { DatabaseService } from "../src/core/database/database.service";
import { createTestApp, resetDatabase } from "./support/app";
import { loginAs } from "./support/auth";

describe("Clients et Sites visibles (HTTP)", () => {
  let app: INestApplication;
  let db: DatabaseService;
  let clientA: number;
  let clientB: number;

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DatabaseService);
  });

  beforeEach(async () => {
    await resetDatabase(db);
    clientA = (await db.client.create({ data: { name: "Boulangerie Martin", sites: { create: [{ domain: "martin.fr" }, { domain: "boutique.martin.fr" }] } } })).id;
    clientB = (await db.client.create({ data: { name: "Garage Durand", sites: { create: { domain: "durand.fr" } } } })).id;
    await db.user.create({ data: { email: "marie@martin.fr", type: "CLIENT", clients: { create: { client_id: clientA } } } });
    await db.user.create({ data: { email: "alice@agence.fr", type: "AGENCY" } });
  });

  afterAll(async () => {
    await app.close();
  });

  it("un Utilisateur client voit ses Clients et leurs Sites, et seulement ceux-là", async () => {
    const marie = await loginAs(app, "marie@martin.fr");
    const res = await marie.get("/me/clients").expect(200);

    expect(res.body).toEqual([
      {
        id: clientA,
        name: "Boulangerie Martin",
        sites: [
          { id: expect.any(Number), domain: "boutique.martin.fr" },
          { id: expect.any(Number), domain: "martin.fr" },
        ],
      },
    ]);
  });

  it("un Utilisateur agence voit tous les Clients", async () => {
    const alice = await loginAs(app, "alice@agence.fr");
    const res = await alice.get("/me/clients").expect(200);
    expect(res.body.map((c: { id: number }) => c.id)).toEqual([clientA, clientB]);
  });

  it("exige une session (401)", async () => {
    await request(app.getHttpServer()).get("/me/clients").expect(401);
  });
});
