import type { INestApplication } from "@nestjs/common";
import { DatabaseService } from "../src/core/database/database.service";
import { IntegrationsService } from "../src/core/integrations/integrations.service";
import { createTestApp, magicLinks, resetDatabase } from "./support/app";
import { loginAs } from "./support/auth";
import { FakeGraph } from "./support/fake-graph";
import { asPlugin, connectPlugin } from "./support/plugin";
import { givenOverride, givenSite } from "./support/rights";

/**
 * Diffuser une Actualité sur une page Facebook depuis le Plugin WP.
 * Marie (Client A) a social.publish sur site-a.fr ; la page « page-1 » y est rattachée.
 */
describe("Diffusion d'une Actualité sur une page Facebook (HTTP)", () => {
  let app: INestApplication;
  let db: DatabaseService;
  const graph = new FakeGraph();

  let clientA: number;
  let siteA: number;
  let marieId: number;
  let pageId: number;
  let token: string;

  const ARTICLE = { id: "42", url: "https://site-a.fr/2026/10/portes-ouvertes" };
  // permissions Meta exigées pour publier sur une page (sans elles : refus prévisible, voir plugin-broadcast-check)
  const PAGE_PUBLISH_SCOPES = ["pages_manage_posts", "pages_read_engagement", "pages_show_list"];

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
    await givenOverride(db, marieId, "social.publish", "ADD");

    pageId = await givenPage("page-1", siteA, [{ externalUserId: "meta-marie", pageToken: "page-token" }]);
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

  /** Une page Facebook atteinte par ces Intégrations (avec chacune son jeton de page). */
  async function givenPage(
    externalId: string,
    siteId: number | null,
    accesses: { externalUserId: string; pageToken: string; status?: "ACTIVE" | "EXPIRED" }[],
  ) {
    const integrations = app.get(IntegrationsService);
    const resource = await db.resource.create({
      data: { provider: "META", type: "FACEBOOK_PAGE", external_id: externalId, name: externalId, site_id: siteId },
    });
    for (const access of accesses) {
      await db.integration.create({
        data: {
          provider: "META",
          external_user_id: access.externalUserId,
          access_token: integrations.encrypt("user-token"),
          scopes: PAGE_PUBLISH_SCOPES,
          status: access.status ?? "ACTIVE",
          client_id: clientA,
          created_by_id: marieId,
          resources: { create: { resource_id: resource.id, access_token: integrations.encrypt(access.pageToken) } },
        },
      });
    }
    return resource.id;
  }

  /** Meta accepte le post et donne son lien. */
  function metaAcceptsPost(postId = "page-1_777") {
    graph.on("POST", "/page-1/feed", { id: postId });
    graph.on("GET", `/${postId}`, { id: postId, permalink_url: `https://www.facebook.com/${postId}` });
  }

  /** Une image de la médiathèque WordPress, décrite par le Plugin WP. */
  const image = (name: string) => ({
    url: `https://site-a.fr/wp-content/uploads/${name}`,
    mimeType: "image/jpeg",
    width: 1200,
    height: 800,
    size: 300_000,
  });

  function broadcast(targets: { resourceId: number; text: string }[], images: ReturnType<typeof image>[] = []) {
    return asPlugin(app, token).post("/plugin/broadcasts").send({ actualite: ARTICLE, images, targets });
  }

  const feedCalls = () => graph.calls.filter((c) => c.path === "/page-1/feed");

  it("publie le texte et le lien de l'Actualité sur la page, et trace une Publication réussie", async () => {
    metaAcceptsPost();

    const res = await broadcast([{ resourceId: pageId, text: "Portes ouvertes samedi !" }]).expect(201);

    // ce qui est parti chez Meta
    const [feed] = feedCalls();
    expect(feed.method).toBe("POST");
    expect(feed.query.get("access_token")).toBe("page-token");
    const sent = new URLSearchParams(feed.body);
    expect(sent.get("message")).toBe("Portes ouvertes samedi !");
    expect(sent.get("link")).toBe(ARTICLE.url);

    // ce que le Plugin WP reçoit
    expect(res.body.publications).toEqual([
      expect.objectContaining({
        resource_id: pageId,
        status: "SUCCEEDED",
        network_post_id: "page-1_777",
        network_url: "https://www.facebook.com/page-1_777",
        article_id: "42",
      }),
    ]);
    expect(JSON.stringify(res.body)).not.toContain("token");

    // la trace
    const [trace] = await db.publication.findMany();
    expect(trace).toMatchObject({
      site_id: siteA,
      article_id: "42",
      article_url: ARTICLE.url,
      resource_id: pageId,
      text: "Portes ouvertes samedi !",
      status: "SUCCEEDED",
      network_url: "https://www.facebook.com/page-1_777",
      author_id: marieId,
    });
    expect(trace.published_at).not.toBeNull();
  });

  it("envoie les images à Facebook par leur URL et les joint au post, avec le lien dans le texte", async () => {
    graph.on("POST", "/page-1/photos", { id: "photo-1" });
    metaAcceptsPost();
    const images = [image("facade.jpg"), image("equipe.jpg")];

    const res = await broadcast([{ resourceId: pageId, text: "En images" }], images).expect(201);

    const photos = graph.calls.filter((c) => c.path === "/page-1/photos");
    expect(photos).toHaveLength(2);
    for (const [i, call] of photos.entries()) {
      expect(call.query.get("access_token")).toBe("page-token");
      const sentPhoto = new URLSearchParams(call.body);
      expect(sentPhoto.get("published")).toBe("false");
      expect(sentPhoto.get("url")).toBe(images[i].url); // Meta va la chercher : elle ne transite pas par nous
    }
    expect(res.body.publications[0]).toMatchObject({ format: "post", images }); // enregistrées, pour une relance

    const sent = new URLSearchParams(feedCalls()[0].body);
    expect(sent.get("message")).toBe(`En images\n\n${ARTICLE.url}`);
    expect(sent.get("attached_media[0]")).toBe(JSON.stringify({ media_fbid: "photo-1" }));
    expect(sent.get("attached_media[1]")).toBe(JSON.stringify({ media_fbid: "photo-1" }));
  });

  it("exige social.publish sur le Site du jeton (403), sans rien envoyer à Meta", async () => {
    await db.userFeature.deleteMany();
    await givenOverride(db, marieId, "social.read", "ADD");

    const res = await broadcast([{ resourceId: pageId, text: "Bonjour" }]).expect(403);

    expect(res.body).toMatchObject({ type: "missing-feature", feature: "social.publish" });
    expect(graph.calls).toHaveLength(0);
    expect(await db.publication.count()).toBe(0);
  });

  it("refuse une Ressource non rattachée au Site du jeton, avec un type stable, sans rien envoyer", async () => {
    const siteB = (await givenSite(db, clientA, "site-b.fr", ["social.publish"])).id;
    const elsewhere = await givenPage("page-ailleurs", siteB, [{ externalUserId: "meta-b", pageToken: "t" }]);
    const free = await givenPage("page-libre", null, [{ externalUserId: "meta-c", pageToken: "t" }]);

    for (const resourceId of [elsewhere, free, 999]) {
      const res = await broadcast([
        { resourceId: pageId, text: "Bonjour" },
        { resourceId, text: "Bonjour" },
      ]).expect(422);
      expect(res.body).toMatchObject({ type: "resource-not-attached", resourceIds: [resourceId] });
    }
    expect(graph.calls).toHaveLength(0);
    expect(await db.publication.count()).toBe(0);
  });

  it("publie avec le jeton de page obtenu via une Intégration active", async () => {
    // page-1 n'est plus atteinte que par deux Intégrations : une expirée (la première), puis une active
    await db.integrationResource.deleteMany();
    const integrations = app.get(IntegrationsService);
    for (const [externalUserId, pageToken, status] of [
      ["meta-expiree", "jeton-expire", "EXPIRED"],
      ["meta-active", "jeton-actif", "ACTIVE"],
    ] as const) {
      await db.integration.create({
        data: {
          provider: "META",
          external_user_id: externalUserId,
          access_token: integrations.encrypt("user-token"),
          scopes: PAGE_PUBLISH_SCOPES,
          status,
          client_id: clientA,
          created_by_id: marieId,
          resources: { create: { resource_id: pageId, access_token: integrations.encrypt(pageToken) } },
        },
      });
    }
    metaAcceptsPost();

    await broadcast([{ resourceId: pageId, text: "Bonjour" }]).expect(201);

    expect(feedCalls()[0].query.get("access_token")).toBe("jeton-actif");
  });

  it("n'utilise jamais l'accès Meta d'un autre Client, même s'il mène à la page", async () => {
    await db.integrationResource.deleteMany();
    const integrations = app.get(IntegrationsService);
    const clientB = (await db.client.create({ data: { name: "Client B" } })).id;
    for (const [externalUserId, pageToken, clientId] of [
      ["meta-client-b", "jeton-client-b", clientB],
      ["meta-client-a", "jeton-client-a", clientA],
    ] as const) {
      await db.integration.create({
        data: {
          provider: "META",
          external_user_id: externalUserId,
          access_token: integrations.encrypt("user-token"),
          scopes: PAGE_PUBLISH_SCOPES,
          client_id: clientId,
          created_by_id: marieId,
          resources: { create: { resource_id: pageId, access_token: integrations.encrypt(pageToken) } },
        },
      });
    }
    metaAcceptsPost();

    await broadcast([{ resourceId: pageId, text: "Bonjour" }]).expect(201);

    expect(feedCalls()[0].query.get("access_token")).toBe("jeton-client-a");
  });

  it("un post en ligne reste réussi même si Meta ne donne pas son lien", async () => {
    graph.on("POST", "/page-1/feed", { id: "page-1_777" });
    graph.on("GET", "/page-1_777", { error: { message: "Service temporarily unavailable", code: 2 } }, 500);

    const res = await broadcast([{ resourceId: pageId, text: "Bonjour" }]).expect(201);

    expect(res.body.publications[0]).toMatchObject({ status: "SUCCEEDED", network_url: "https://www.facebook.com/page-1_777" });
  });

  it("un jeton de page refusé échoue sans marquer expirée l'Intégration de la personne", async () => {
    graph.on("POST", "/page-1/feed", { error: { message: "Error validating access token", code: 190 } }, 400);
    // le jeton de la personne, lui, est toujours bon (vérifié après le refus du jeton de page : ticket 11)
    graph.on("GET", "/me", { id: "meta-marie" });

    const res = await broadcast([{ resourceId: pageId, text: "Bonjour" }]).expect(201);

    expect(res.body.publications[0]).toMatchObject({ status: "FAILED", error_type: "integration-expired" });
    expect((await db.integration.findFirstOrThrow()).status).toBe("ACTIVE");
  });

  it("une limite de débit de Meta n'est pas un contenu refusé", async () => {
    graph.on("POST", "/page-1/feed", { error: { message: "Application request limit reached", code: 4 } }, 400);

    const res = await broadcast([{ resourceId: pageId, text: "Bonjour" }]).expect(201);

    expect(res.body.publications[0]).toMatchObject({ status: "FAILED", error_type: "network-unavailable" });
  });

  it("trace l'échec quand Meta refuse le contenu, avec une raison au type stable", async () => {
    graph.on("POST", "/page-1/feed", { error: { message: "Invalid parameter", code: 100 } }, 400);

    const res = await broadcast([{ resourceId: pageId, text: "Bonjour" }]).expect(201);

    expect(res.body.publications[0]).toMatchObject({ status: "FAILED", error_type: "content-rejected" });
    expect(await db.publication.findFirstOrThrow()).toMatchObject({ status: "FAILED", error_type: "content-rejected" });
  });

  it("la trace survit à la déconnexion de l'Intégration utilisée, et garde sa Ressource", async () => {
    metaAcceptsPost();
    await broadcast([{ resourceId: pageId, text: "Bonjour" }]).expect(201);

    const agency = await db.user.create({ data: { email: "alice@agence.fr", type: "AGENCY" } });
    await givenOverride(db, agency.id, "social.manage", "ADD");
    const alice = await loginAs(app, "alice@agence.fr");
    await db.resource.update({ where: { id: pageId }, data: { site_id: null } }); // plus rattachée : seule la trace la retient
    for (const { id } of await db.integration.findMany()) await alice.delete(`/integrations/${id}`).expect(204);

    expect(await db.resource.count({ where: { id: pageId } })).toBe(1);
    expect(await db.publication.findFirstOrThrow()).toMatchObject({ resource_id: pageId, status: "SUCCEEDED" });
  });

  it.each([
    ["sans cible", { actualite: ARTICLE, targets: [] }],
    ["sans lien d'Actualité", { actualite: { id: "42" }, targets: [{ resourceId: 1, text: "x" }] }],
    ["avec une Actualité qui n'est pas un objet", { actualite: "{pas du json", targets: [{ resourceId: 1, text: "x" }] }],
    ["avec un format qui n'est pas une chaîne", { actualite: ARTICLE, targets: [{ resourceId: 1, text: "x", format: 3 }] }],
  ])("refuse une requête mal formée %s (400)", async (_, body) => {
    const res = await asPlugin(app, token).post("/plugin/broadcasts").send(body).expect(400);
    expect(res.body.status).toBe(400);
    expect(graph.calls).toHaveLength(0);
  });

  it("la connexion Meta demande la permission de publier sur les pages", async () => {
    const agency = await db.user.create({ data: { email: "alice@agence.fr", type: "AGENCY" } });
    await givenOverride(db, agency.id, "social.manage", "ADD");
    const alice = await loginAs(app, "alice@agence.fr");

    const res = await alice.get(`/integrations/oauth/connect?clientId=${clientA}`).expect(302);

    expect(new URL(res.headers.location).searchParams.get("scope")?.split(",")).toContain("pages_manage_posts");
  });
});
