import type { INestApplication } from "@nestjs/common";
import type TestAgent from "supertest/lib/agent";
import { DatabaseService } from "../src/core/database/database.service";
import { IntegrationsService } from "../src/core/integrations/integrations.service";
import { createTestApp, resetDatabase } from "./support/app";
import { loginAs } from "./support/auth";
import { givenOverride, givenPack, givenSite } from "./support/rights";

/**
 * Calcul des droits social.* : packs, surcharges (REMOVE l'emporte), plafond du Site,
 * appartenance au Client. Chaque règle est vérifiée par une route protégée :
 * le rattachement d'une Ressource à un Site exige `social.manage` sur ce Site.
 */
describe("Droits social.* (HTTP)", () => {
  let app: INestApplication;
  let db: DatabaseService;
  let clientA: number;
  let clientB: number;
  let siteA: number; // Site du Client A, plafond : social.*
  let siteB: number; // Site du Client B, plafond : social.*
  let resourceId: number;

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DatabaseService);
  });

  beforeEach(async () => {
    await resetDatabase(db);
    clientA = (await db.client.create({ data: { name: "Client A" } })).id;
    clientB = (await db.client.create({ data: { name: "Client B" } })).id;
    const social = ["social.read", "social.publish", "social.manage"];
    siteA = (await givenSite(db, clientA, "site-a.fr", social)).id;
    siteB = (await givenSite(db, clientB, "site-b.fr", social)).id;
    resourceId = (await givenResource()).id;
  });

  afterAll(async () => {
    await app.close();
  });

  /** Une Ressource connectée par l'agence, encore rattachée à aucun Site. */
  async function givenResource() {
    const owner = await db.user.create({ data: { email: "proprietaire@agence.fr", type: "AGENCY" } });
    const integration = await db.integration.create({
      data: {
        provider: "META",
        external_user_id: "meta-user-1",
        access_token: app.get(IntegrationsService).encrypt("user-token"),
        scopes: [],
        created_by_id: owner.id,
      },
    });
    return db.integrationResource.create({
      data: { integration_id: integration.id, type: "FACEBOOK_PAGE", external_id: "page-1", name: "Boulangerie Martin" },
    });
  }

  /** Un Utilisateur client rattaché aux Clients donnés. */
  async function clientUser(email: string, clientIds: number[]) {
    const user = await db.user.create({
      data: { email, type: "CLIENT", clients: { create: clientIds.map((client_id) => ({ client_id })) } },
    });
    return user.id;
  }

  const attach = (agent: TestAgent, siteId: number | null) =>
    agent.patch(`/integrations/resources/${resourceId}`).send({ siteId });

  async function expectGranted(email: string, siteId: number) {
    const res = await attach(await loginAs(app, email), siteId).expect(200);
    expect(res.body.site_id).toBe(siteId);
  }

  async function expectDenied(email: string, siteId: number) {
    const res = await attach(await loginAs(app, email), siteId)
      .expect(403)
      .expect("Content-Type", /application\/problem\+json/);
    expect(res.body).toEqual({
      type: "missing-feature",
      title: "Droit manquant",
      status: 403,
      detail: "Fonctionnalité social.manage requise",
      feature: "social.manage",
    });
    expect((await db.integrationResource.findUniqueOrThrow({ where: { id: resourceId } })).site_id).toBeNull();
  }

  describe("sources du droit", () => {
    it("sans pack ni surcharge, aucun droit", async () => {
      await clientUser("marie@client-a.fr", [clientA]);
      await expectDenied("marie@client-a.fr", siteA);
    });

    it("un pack sur ce Site donne le droit", async () => {
      const marie = await clientUser("marie@client-a.fr", [clientA]);
      await givenPack(db, marie, ["social.manage"], siteA);
      await expectGranted("marie@client-a.fr", siteA);
    });

    it("un pack sur tous les Sites donne le droit", async () => {
      const marie = await clientUser("marie@client-a.fr", [clientA]);
      await givenPack(db, marie, ["social.manage"]);
      await expectGranted("marie@client-a.fr", siteA);
    });

    it("un pack sur un autre Site ne donne pas le droit sur celui-ci", async () => {
      const marie = await clientUser("marie@client-a.fr", [clientA]);
      const autre = await givenSite(db, clientA, "autre-a.fr", ["social.manage"]);
      await givenPack(db, marie, ["social.manage"], autre.id);
      await expectDenied("marie@client-a.fr", siteA);
    });

    it("un pack sans la Fonctionnalité ne donne pas le droit", async () => {
      const marie = await clientUser("marie@client-a.fr", [clientA]);
      await givenPack(db, marie, ["social.read", "social.publish"]);
      await expectDenied("marie@client-a.fr", siteA);
    });

    it("une surcharge ADD sur ce Site donne le droit", async () => {
      const marie = await clientUser("marie@client-a.fr", [clientA]);
      await givenOverride(db, marie, "social.manage", "ADD", siteA);
      await expectGranted("marie@client-a.fr", siteA);
    });

    it("une surcharge ADD sur tous les Sites donne le droit", async () => {
      const marie = await clientUser("marie@client-a.fr", [clientA]);
      await givenOverride(db, marie, "social.manage", "ADD");
      await expectGranted("marie@client-a.fr", siteA);
    });
  });

  describe("REMOVE l'emporte sur ADD", () => {
    it("une surcharge REMOVE sur ce Site retire le droit donné par un pack", async () => {
      const marie = await clientUser("marie@client-a.fr", [clientA]);
      await givenPack(db, marie, ["social.manage"]);
      await givenOverride(db, marie, "social.manage", "REMOVE", siteA);
      await expectDenied("marie@client-a.fr", siteA);
    });

    it("une surcharge REMOVE sur tous les Sites retire un ADD sur ce Site", async () => {
      const marie = await clientUser("marie@client-a.fr", [clientA]);
      await givenOverride(db, marie, "social.manage", "ADD", siteA);
      await givenOverride(db, marie, "social.manage", "REMOVE");
      await expectDenied("marie@client-a.fr", siteA);
    });

    it("une surcharge REMOVE sur un autre Site ne retire rien ici", async () => {
      const marie = await clientUser("marie@client-a.fr", [clientA]);
      const autre = await givenSite(db, clientA, "autre-a.fr", ["social.manage"]);
      await givenPack(db, marie, ["social.manage"]);
      await givenOverride(db, marie, "social.manage", "REMOVE", autre.id);
      await expectGranted("marie@client-a.fr", siteA);
    });
  });

  describe("plafond du Site", () => {
    it("une Fonctionnalité absente du Site n'est jamais accordée, même par surcharge", async () => {
      const marie = await clientUser("marie@client-a.fr", [clientA]);
      const sansSocial = await givenSite(db, clientA, "sans-social.fr", ["social.read"]);
      await givenPack(db, marie, ["social.manage"]);
      await givenOverride(db, marie, "social.manage", "ADD", sansSocial.id);
      await expectDenied("marie@client-a.fr", sansSocial.id);
    });
  });

  describe("appartenance au Client", () => {
    it("un Utilisateur client n'a aucun droit sur un Site d'un autre Client", async () => {
      const marie = await clientUser("marie@client-a.fr", [clientA]);
      await givenOverride(db, marie, "social.manage", "ADD");
      await givenOverride(db, marie, "social.manage", "ADD", siteB);
      await expectDenied("marie@client-a.fr", siteB);
    });

    it("un Utilisateur client de plusieurs Clients a ses droits sur les Sites de chacun", async () => {
      const paul = await clientUser("paul@multi.fr", [clientA, clientB]);
      await givenOverride(db, paul, "social.manage", "ADD");
      await expectGranted("paul@multi.fr", siteB);
    });

    it("un Utilisateur agence accède à tous les Clients, sans rattachement", async () => {
      const agent = await db.user.create({ data: { email: "agent@agence.fr", type: "AGENCY" } });
      await givenOverride(db, agent.id, "social.manage", "ADD");
      await expectGranted("agent@agence.fr", siteB);
    });

    it("un Utilisateur agence suit les mêmes règles : sans pack ni surcharge, aucun droit", async () => {
      await db.user.create({ data: { email: "agent@agence.fr", type: "AGENCY" } });
      await expectDenied("agent@agence.fr", siteB);
    });

    it("un Utilisateur agence suit les mêmes règles : REMOVE et plafond s'appliquent", async () => {
      const agent = await db.user.create({ data: { email: "agent@agence.fr", type: "AGENCY" } });
      const sansSocial = await givenSite(db, clientB, "sans-social.fr");
      await givenPack(db, agent.id, ["social.manage"]);
      await givenOverride(db, agent.id, "social.manage", "REMOVE", siteA);
      await expectDenied("agent@agence.fr", siteA);
      await expectDenied("agent@agence.fr", sansSocial.id);
      await expectGranted("agent@agence.fr", siteB);
    });
  });

  describe("détachement", () => {
    it("détacher exige social.manage sur le Site auquel la Ressource est rattachée", async () => {
      await db.integrationResource.update({ where: { id: resourceId }, data: { site_id: siteA } });
      const marie = await clientUser("marie@client-a.fr", [clientA]);
      const bob = await clientUser("bob@client-b.fr", [clientB]);
      await givenOverride(db, bob, "social.manage", "ADD");
      await givenOverride(db, marie, "social.manage", "ADD", siteA);

      await attach(await loginAs(app, "bob@client-b.fr"), null).expect(403);
      const res = await attach(await loginAs(app, "marie@client-a.fr"), null).expect(200);
      expect(res.body.site_id).toBeNull();
    });

    it("rattacher ailleurs exige aussi social.manage sur le Site actuel : pas de Ressource prise à un autre Client", async () => {
      await db.integrationResource.update({ where: { id: resourceId }, data: { site_id: siteB } });
      const marie = await clientUser("marie@client-a.fr", [clientA]);
      await givenOverride(db, marie, "social.manage", "ADD");

      await attach(await loginAs(app, "marie@client-a.fr"), siteA).expect(403);
      expect((await db.integrationResource.findUniqueOrThrow({ where: { id: resourceId } })).site_id).toBe(siteB);
    });
  });

  describe("gestion des Intégrations sans social.manage", () => {
    let integrationId: number;
    let lecteur: TestAgent;

    beforeEach(async () => {
      integrationId = (await db.integrationResource.findUniqueOrThrow({ where: { id: resourceId } })).integration_id;
      const marie = await clientUser("marie@client-a.fr", [clientA]);
      await givenOverride(db, marie, "social.read", "ADD");
      await givenOverride(db, marie, "social.publish", "ADD");
      lecteur = await loginAs(app, "marie@client-a.fr");
    });

    it.each([
      ["GET", "/integrations/oauth/connect"],
      ["GET", "/integrations"],
      ["GET", "/integrations/:id"],
      ["POST", "/integrations/:id/resources/sync"],
      ["DELETE", "/integrations/:id"],
    ])("%s %s renvoie 403 Problem Details", async (method, path) => {
      const url = path.replace(":id", String(integrationId));
      const res = await lecteur[method.toLowerCase() as "get" | "post" | "delete"](url)
        .expect(403)
        .expect("Content-Type", /application\/problem\+json/);
      expect(res.body).toMatchObject({ type: "missing-feature", status: 403, feature: "social.manage" });
    });

    it("social.manage sur un Site d'un Client ne permet pas de gérer les Intégrations d'un autre Client", async () => {
      const marie = await db.user.findUniqueOrThrow({ where: { email: "marie@client-a.fr" } });
      await givenOverride(db, marie.id, "social.manage", "ADD");

      await lecteur.get(`/integrations?clientId=${clientA}`).expect(200);
      await lecteur.get(`/integrations?clientId=${clientB}`).expect(403);
      await lecteur.get(`/integrations/oauth/connect?clientId=${clientB}`).expect(403);
      await lecteur.get(`/integrations/oauth/connect?clientId=${clientA}`).expect(302);
    });

    it("les accès de l'agence et la liste de tous les Clients sont réservés aux Utilisateurs agence", async () => {
      const marie = await db.user.findUniqueOrThrow({ where: { email: "marie@client-a.fr" } });
      await givenOverride(db, marie.id, "social.manage", "ADD");

      for (const send of [
        () => lecteur.get("/integrations"),
        () => lecteur.get("/integrations/oauth/connect"),
        () => lecteur.get(`/integrations/${integrationId}`),
        () => lecteur.delete(`/integrations/${integrationId}`),
      ]) {
        const res = await send().expect(403);
        expect(res.body.type).toBe("agency-only");
      }
      expect(await db.integration.count()).toBe(1);

      const agent = await db.user.create({ data: { email: "agent@agence.fr", type: "AGENCY" } });
      await givenOverride(db, agent.id, "social.manage", "ADD");
      const agence = await loginAs(app, "agent@agence.fr");
      await agence.get("/integrations").expect(200);
      await agence.get(`/integrations/${integrationId}`).expect(200);
    });
  });
});
