import type { INestApplication } from "@nestjs/common";
import { DatabaseService } from "../src/core/database/database.service";
import { IntegrationsService } from "../src/core/integrations/integrations.service";
import { createTestApp, magicLinks, resetDatabase } from "./support/app";
import { loginAs } from "./support/auth";
import { FakeGraph } from "./support/fake-graph";
import { asPlugin, connectPlugin } from "./support/plugin";
import { givenOverride, givenSite } from "./support/rights";

const PAGE_PUBLISH_SCOPES = ["pages_manage_posts", "pages_read_engagement", "pages_show_list"];
const TOKEN_REFUSED = { error: { message: "Error validating access token", code: 190 } };

type Access = { externalUserId: string; userToken: string; pageToken: string; status?: "ACTIVE" | "EXPIRED" };

/**
 * Échecs imprévisibles (ceux que seul Meta révèle), repli vers une autre Intégration, relance
 * d'une Publication échouée et historique d'une Actualité.
 * Marie (Client A) a social.read et social.publish sur site-a.fr.
 */
describe("Échecs, relance et historique des Publications (HTTP)", () => {
  let app: INestApplication;
  let db: DatabaseService;
  const graph = new FakeGraph();

  let clientA: number;
  let siteA: number;
  let marieId: number;
  let pageId: number;
  let token: string;

  const ARTICLE = { id: "42", url: "https://site-a.fr/2026/10/portes-ouvertes" };
  const MARIE: Access = { externalUserId: "meta-marie", userToken: "jeton-marie", pageToken: "page-marie" };
  const PAUL: Access = { externalUserId: "meta-paul", userToken: "jeton-paul", pageToken: "page-paul" };

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DatabaseService);
  });

  beforeEach(async () => {
    await resetDatabase(db);
    magicLinks(app).sent.length = 0;
    clientA = (await db.client.create({ data: { name: "Client A" } })).id;
    siteA = (await givenSite(db, clientA, "site-a.fr", ["social.read", "social.publish", "social.manage"])).id;
    marieId = (await db.user.create({ data: { email: "marie@client-a.fr", type: "CLIENT", clients: { create: { client_id: clientA } } } })).id;
    await givenOverride(db, marieId, "social.read", "ADD");
    await givenOverride(db, marieId, "social.publish", "ADD");

    pageId = await givenPage("page-1", [MARIE]);
    token = await connectPlugin(app, "marie@client-a.fr", siteA, "site-a.fr");
    graph.install();
  });

  afterEach(() => {
    graph.uninstall();
    graph.assertNoUnexpectedCalls();
  });

  afterAll(async () => {
    await app.close();
  });

  /** Une page Facebook rattachée au Site (par défaut site-a.fr), atteinte par ces Intégrations, dans cet ordre. */
  async function givenPage(externalId: string, accesses: Access[], siteId = siteA) {
    const integrations = app.get(IntegrationsService);
    const resource = await db.resource.create({
      data: { provider: "META", type: "FACEBOOK_PAGE", external_id: externalId, name: `Page ${externalId}`, site_id: siteId },
    });
    for (const access of accesses) {
      const existing = await db.integration.findFirst({ where: { external_user_id: access.externalUserId } });
      const link = { resource_id: resource.id, access_token: integrations.encrypt(access.pageToken) };
      if (existing) {
        await db.integrationResource.create({ data: { ...link, integration_id: existing.id } });
        continue;
      }
      await db.integration.create({
        data: {
          provider: "META",
          external_user_id: access.externalUserId,
          access_token: integrations.encrypt(access.userToken),
          scopes: PAGE_PUBLISH_SCOPES,
          status: access.status ?? "ACTIVE",
          client_id: clientA,
          created_by_id: marieId,
          resources: { create: link },
        },
      });
    }
    return resource.id;
  }

  /** Meta accepte un post sur cette page, publié avec ce jeton de page. */
  function metaAcceptsPost(page: string, pageToken: string, postId = `${page}_777`) {
    graph.on("POST", `/${page}/feed`, { id: postId }, 200, { access_token: pageToken });
    graph.on("GET", `/${postId}`, { id: postId, permalink_url: `https://www.facebook.com/${postId}` });
  }

  function broadcast(targets: { resourceId: number; text: string }[], article = ARTICLE) {
    return asPlugin(app, token)
      .post("/plugin/broadcasts")
      .field("actualite", JSON.stringify(article))
      .field("targets", JSON.stringify(targets));
  }

  function retry(publicationId: number, images: { name: string; bytes: Buffer }[] = []) {
    let req = asPlugin(app, token).post(`/plugin/publications/${publicationId}/retry`);
    for (const image of images) req = req.attach("images", image.bytes, { filename: image.name, contentType: "image/jpeg" });
    return req;
  }

  const history = (articleId: string) => asPlugin(app, token).get(`/plugin/articles/${articleId}/publications`);
  const feedCalls = (page = "page-1") => graph.calls.filter((c) => c.path === `/${page}/feed`);
  const integrationOf = (externalUserId: string) => db.integration.findFirstOrThrow({ where: { external_user_id: externalUserId } });

  /** Une Publication déjà échouée sur page-1 (Meta a refusé le contenu). */
  async function givenFailedPublication(text = "Portes ouvertes samedi !") {
    graph.on("POST", "/page-1/feed", { error: { message: "Invalid parameter", code: 100 } }, 400);
    const res = await broadcast([{ resourceId: pageId, text }]).expect(201);
    graph.reset();
    graph.calls.length = 0;
    return res.body.publications[0].id as number;
  }

  describe("échecs imprévisibles", () => {
    it("l'échec d'une Ressource n'empêche pas la réussite de l'autre ; la réponse donne le statut de chacune", async () => {
      const page2 = await givenPage("page-2", [MARIE]);
      metaAcceptsPost("page-1", "page-marie");
      graph.on("POST", "/page-2/feed", { error: { message: "Invalid parameter", code: 100 } }, 400);

      const res = await broadcast([
        { resourceId: pageId, text: "Bonjour" },
        { resourceId: page2, text: "Bonjour" },
      ]).expect(201);

      expect(res.body.publications).toEqual([
        expect.objectContaining({ resource_id: pageId, status: "SUCCEEDED", network_url: "https://www.facebook.com/page-1_777" }),
        expect.objectContaining({ resource_id: page2, status: "FAILED", error_type: "content-rejected", network_url: null }),
      ]);
      expect(await db.publication.findMany({ orderBy: { id: "asc" }, select: { status: true, error_type: true } })).toEqual([
        { status: "SUCCEEDED", error_type: null },
        { status: "FAILED", error_type: "content-rejected" },
      ]);
    });

    it("jeton de la personne révoqué : son Intégration est marquée expirée, et la Diffusion passe par une autre", async () => {
      await db.integrationResource.deleteMany();
      await db.integration.deleteMany();
      await db.resource.delete({ where: { id: pageId } });
      pageId = await givenPage("page-1", [MARIE, PAUL]);
      graph.on("POST", "/page-1/feed", TOKEN_REFUSED, 400, { access_token: "page-marie" });
      graph.on("GET", "/me", TOKEN_REFUSED, 400, { access_token: "jeton-marie" });
      metaAcceptsPost("page-1", "page-paul");

      const res = await broadcast([{ resourceId: pageId, text: "Bonjour" }]).expect(201);

      expect(res.body.publications[0]).toMatchObject({ status: "SUCCEEDED", error_type: null });
      expect(feedCalls().map((c) => c.query.get("access_token"))).toEqual(["page-marie", "page-paul"]);
      expect((await integrationOf("meta-marie")).status).toBe("EXPIRED");
      expect((await integrationOf("meta-paul")).status).toBe("ACTIVE");
    });

    it("jeton de page refusé mais jeton de la personne valide (rôle perdu sur la page) : l'Intégration reste active, la Diffusion passe par une autre", async () => {
      await db.integrationResource.deleteMany();
      await db.integration.deleteMany();
      await db.resource.delete({ where: { id: pageId } });
      pageId = await givenPage("page-1", [MARIE, PAUL]);
      graph.on("POST", "/page-1/feed", TOKEN_REFUSED, 400, { access_token: "page-marie" });
      graph.on("GET", "/me", { id: "meta-marie" }, 200, { access_token: "jeton-marie" });
      metaAcceptsPost("page-1", "page-paul");

      const res = await broadcast([{ resourceId: pageId, text: "Bonjour" }]).expect(201);

      expect(res.body.publications[0]).toMatchObject({ status: "SUCCEEDED" });
      const marie = await integrationOf("meta-marie");
      expect(marie.status).toBe("ACTIVE");
      // son jeton de page est oublié : il ne sera plus essayé (la prochaine synchronisation le rendra)
      const link = await db.integrationResource.findFirstOrThrow({ where: { integration_id: marie.id, resource_id: pageId } });
      expect(link.access_token).toBeNull();
    });

    it("toutes les Intégrations refusées : la Publication échoue, tracée integration-expired", async () => {
      await db.integrationResource.deleteMany();
      await db.integration.deleteMany();
      await db.resource.delete({ where: { id: pageId } });
      pageId = await givenPage("page-1", [MARIE, PAUL]);
      graph.on("POST", "/page-1/feed", TOKEN_REFUSED, 400);
      graph.on("GET", "/me", TOKEN_REFUSED, 400);

      const res = await broadcast([{ resourceId: pageId, text: "Bonjour" }]).expect(201);

      expect(res.body.publications[0]).toMatchObject({ status: "FAILED", error_type: "integration-expired" });
      expect(feedCalls()).toHaveLength(2);
      expect(await db.integration.count({ where: { status: "EXPIRED" } })).toBe(2);
    });

    it("un contenu refusé par Meta ne change pas d'Intégration : ce n'est pas une question d'accès", async () => {
      await db.integrationResource.deleteMany();
      await db.integration.deleteMany();
      await db.resource.delete({ where: { id: pageId } });
      pageId = await givenPage("page-1", [MARIE, PAUL]);
      graph.on("POST", "/page-1/feed", { error: { message: "Invalid parameter", code: 100 } }, 400);

      const res = await broadcast([{ resourceId: pageId, text: "Bonjour" }]).expect(201);

      expect(res.body.publications[0]).toMatchObject({ status: "FAILED", error_type: "content-rejected" });
      expect(feedCalls()).toHaveLength(1);
    });
  });

  describe("relance", () => {
    it("renvoie une Publication échouée avec le même contenu et met à jour son statut", async () => {
      const id = await givenFailedPublication("Portes ouvertes samedi !");
      metaAcceptsPost("page-1", "page-marie");

      const res = await retry(id).expect(200);

      expect(res.body).toMatchObject({
        id,
        status: "SUCCEEDED",
        error_type: null,
        error_detail: null,
        network_url: "https://www.facebook.com/page-1_777",
      });
      const sent = new URLSearchParams(feedCalls()[0].body);
      expect(sent.get("message")).toBe("Portes ouvertes samedi !");
      expect(sent.get("link")).toBe(ARTICLE.url);
      // la même Publication, pas une nouvelle
      expect(await db.publication.findMany()).toEqual([expect.objectContaining({ id, status: "SUCCEEDED" })]);
    });

    it("renvoie les images que le Plugin WP joint à la relance", async () => {
      const id = await givenFailedPublication();
      await db.publication.update({ where: { id }, data: { image_count: 1 } }); // diffusée avec une image
      graph.on("POST", "/page-1/photos", { id: "photo-1" });
      metaAcceptsPost("page-1", "page-marie");

      await retry(id, [{ name: "facade.jpg", bytes: Buffer.from("image-facade") }]).expect(200);

      expect(graph.calls.filter((c) => c.path === "/page-1/photos")).toHaveLength(1);
      expect(new URLSearchParams(feedCalls()[0].body).get("attached_media[0]")).toBe(JSON.stringify({ media_fbid: "photo-1" }));
    });

    it("exige les images d'origine : elles ne sont pas conservées (422), sans rien envoyer", async () => {
      const id = await givenFailedPublication();
      await db.publication.update({ where: { id }, data: { image_count: 2 } });

      const res = await retry(id, [{ name: "facade.jpg", bytes: Buffer.from("image-facade") }]).expect(422);

      expect(res.body).toMatchObject({ type: "retry-images-mismatch", imageCount: 2 });
      expect(graph.calls).toHaveLength(0);
    });

    it("refuse de relancer une Publication en cours d'envoi (409)", async () => {
      const id = await givenFailedPublication();
      await db.publication.update({ where: { id }, data: { status: "PENDING", attempted_at: new Date() } });

      const res = await retry(id).expect(409);

      expect(res.body).toMatchObject({ type: "publication-in-progress" });
      expect(graph.calls).toHaveLength(0);
    });

    it("relance une Publication restée en cours trop longtemps (envoi interrompu)", async () => {
      const id = await givenFailedPublication();
      const longAgo = new Date(Date.now() - 20 * 60 * 1000);
      await db.publication.update({ where: { id }, data: { status: "PENDING", error_type: null, attempted_at: longAgo } });
      metaAcceptsPost("page-1", "page-marie");

      const res = await retry(id).expect(200);

      expect(res.body).toMatchObject({ id, status: "SUCCEEDED" });
      expect(new Date(res.body.attempted_at).getTime()).toBeGreaterThan(longAgo.getTime());
    });

    it("trace un nouvel échec avec sa nouvelle raison", async () => {
      const id = await givenFailedPublication();
      graph.on("POST", "/page-1/feed", { error: { message: "Service unavailable", code: 2 } }, 500);

      const res = await retry(id).expect(200);

      expect(res.body).toMatchObject({ id, status: "FAILED", error_type: "network-unavailable" });
    });

    it("refuse de relancer une Publication réussie (409), sans rien envoyer", async () => {
      metaAcceptsPost("page-1", "page-marie");
      const [publication] = (await broadcast([{ resourceId: pageId, text: "Bonjour" }]).expect(201)).body.publications;
      graph.calls.length = 0;

      const res = await retry(publication.id).expect(409);

      expect(res.body).toMatchObject({ type: "publication-already-succeeded", status: 409 });
      expect(graph.calls).toHaveLength(0);
    });

    it("bloque la relance par un refus prévisible (422), sans rien envoyer ni changer la Publication", async () => {
      const id = await givenFailedPublication();
      await db.integration.updateMany({ data: { status: "EXPIRED" } });

      const res = await retry(id).expect(422);

      expect(res.body).toMatchObject({ type: "broadcast-refused" });
      expect(res.body.targets).toEqual([{ resourceId: pageId, refusals: [expect.objectContaining({ type: "integration-expired" })] }]);
      expect(graph.calls).toHaveLength(0);
      expect(await db.publication.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "FAILED", error_type: "content-rejected" });
    });

    it("ne relance pas la Publication d'un autre Site (404)", async () => {
      const siteB = (await givenSite(db, clientA, "site-b.fr", ["social.publish"])).id;
      const pageB = await givenPage("page-b", [MARIE], siteB);
      const other = await db.publication.create({
        data: { site_id: siteB, article_id: "7", article_url: "https://site-b.fr/7", resource_id: pageB, text: "x", status: "FAILED" },
      });

      const res = await retry(other.id).expect(404);

      expect(res.body).toMatchObject({ type: "publication-not-found" });
    });

    it("exige social.publish (403)", async () => {
      const id = await givenFailedPublication();
      await db.userFeature.deleteMany({ where: { feature: { slug: "social.publish" } } });

      const res = await retry(id).expect(403);

      expect(res.body).toMatchObject({ type: "missing-feature", feature: "social.publish" });
    });
  });

  describe("historique d'une Actualité", () => {
    it("liste ses Publications, de la plus récente à la plus ancienne : Ressource, statut, lien, dates", async () => {
      const page2 = await givenPage("page-2", [MARIE]);
      metaAcceptsPost("page-1", "page-marie");
      graph.on("POST", "/page-2/feed", { error: { message: "Invalid parameter", code: 100 } }, 400);
      await broadcast([{ resourceId: pageId, text: "Bonjour" }]).expect(201);
      await broadcast([{ resourceId: page2, text: "Bonjour" }]).expect(201);
      // une autre Actualité, et la même Actualité sur un autre Site : hors de cet historique
      metaAcceptsPost("page-1", "page-marie", "page-1_888");
      await broadcast([{ resourceId: pageId, text: "Autre" }], { id: "43", url: "https://site-a.fr/43" }).expect(201);
      const siteB = (await givenSite(db, clientA, "site-b.fr", ["social.publish"])).id;
      const pageB = await givenPage("page-b", [MARIE], siteB);
      await db.publication.create({
        data: { site_id: siteB, article_id: "42", article_url: "https://site-b.fr/42", resource_id: pageB, text: "x", status: "FAILED" },
      });

      const res = await history("42").expect(200);

      expect(res.body).toEqual([
        expect.objectContaining({
          resource_id: page2,
          resource: { id: page2, type: "FACEBOOK_PAGE", name: "Page page-2" },
          status: "FAILED",
          error_type: "content-rejected",
          network_url: null,
          created_at: expect.any(String),
          published_at: null,
        }),
        expect.objectContaining({
          resource_id: pageId,
          resource: { id: pageId, type: "FACEBOOK_PAGE", name: "Page page-1" },
          status: "SUCCEEDED",
          network_url: "https://www.facebook.com/page-1_777",
          published_at: expect.any(String),
        }),
      ]);
    });

    it("reste complet après la déconnexion de l'Intégration utilisée et le détachement de la page", async () => {
      metaAcceptsPost("page-1", "page-marie");
      await broadcast([{ resourceId: pageId, text: "Bonjour" }]).expect(201);

      const agency = await db.user.create({ data: { email: "alice@agence.fr", type: "AGENCY" } });
      await givenOverride(db, agency.id, "social.manage", "ADD");
      const alice = await loginAs(app, "alice@agence.fr");
      await db.resource.update({ where: { id: pageId }, data: { site_id: null } });
      for (const { id } of await db.integration.findMany()) await alice.delete(`/integrations/${id}`).expect(204);

      const res = await history("42").expect(200);

      expect(res.body).toEqual([
        expect.objectContaining({
          resource: { id: pageId, type: "FACEBOOK_PAGE", name: "Page page-1" },
          status: "SUCCEEDED",
          network_url: "https://www.facebook.com/page-1_777",
        }),
      ]);
    });

    it("une Actualité jamais diffusée a un historique vide", async () => {
      await history("999").expect(200, []);
    });

    it("exige social.read ou social.publish (403)", async () => {
      await db.userFeature.deleteMany();

      const res = await history("42").expect(403);

      expect(res.body).toMatchObject({ type: "missing-feature" });
    });
  });
});
