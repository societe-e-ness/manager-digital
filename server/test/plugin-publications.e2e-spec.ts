import type { INestApplication } from "@nestjs/common";
import { DatabaseService } from "../src/core/database/database.service";
import { IntegrationsService } from "../src/core/integrations/integrations.service";
import { PublicationsFeedService } from "../src/core/plugin-social/publications-feed.service";
import { createTestApp, magicLinks, resetDatabase } from "./support/app";
import { loginAs } from "./support/auth";
import { FakeGraph } from "./support/fake-graph";
import { asPlugin, connectPlugin } from "./support/plugin";
import { givenOverride, givenSite } from "./support/rights";

/**
 * Lister les Publications des Ressources du Site depuis le Plugin WP.
 * Site A : la page Facebook « page-1 » et son compte Instagram « ig-1 », atteints par l'Intégration de Marie.
 */
describe("Publications des Ressources du Site (HTTP)", () => {
  let app: INestApplication;
  let db: DatabaseService;
  const graph = new FakeGraph();

  let clientA: number;
  let siteA: number;
  let marieId: number;
  let integrationId: number;
  let pageId: number;
  let igId: number;
  let token: string;

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DatabaseService);
  });

  beforeEach(async () => {
    await resetDatabase(db);
    magicLinks(app).sent.length = 0;
    app.get(PublicationsFeedService).clearCache();
    clientA = (await db.client.create({ data: { name: "Client A" } })).id;
    siteA = (await givenSite(db, clientA, "site-a.fr", ["social.read", "social.publish", "social.manage"])).id;
    marieId = (await db.user.create({ data: { email: "marie@client-a.fr", type: "CLIENT", clients: { create: { client_id: clientA } } } })).id;
    await givenOverride(db, marieId, "social.read", "ADD");

    const integrations = app.get(IntegrationsService);
    integrationId = (
      await db.integration.create({
        data: {
          provider: "META",
          external_user_id: "meta-marie",
          access_token: integrations.encrypt("user-token"),
          expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000),
          scopes: [],
          client_id: clientA,
          created_by_id: marieId,
        },
      })
    ).id;
    pageId = await givenResource("FACEBOOK_PAGE", "page-1", integrations.encrypt("page-token"));
    igId = await givenResource("INSTAGRAM_ACCOUNT", "ig-1", null);

    token = await connectPlugin(app, "marie@client-a.fr", siteA, "site-a.fr");
    graph.install();
  });

  afterEach(() => {
    graph.uninstall();
    graph.assertNoUnexpectedCalls();
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  async function givenResource(type: "FACEBOOK_PAGE" | "INSTAGRAM_ACCOUNT", externalId: string, pageToken: string | null) {
    const resource = await db.resource.create({
      data: {
        provider: "META",
        type,
        external_id: externalId,
        name: externalId,
        site_id: siteA,
        integrations: { create: { integration_id: integrationId, access_token: pageToken } },
      },
    });
    return resource.id;
  }

  /** Des posts Facebook au format de la Graph API. */
  function facebookPosts(posts: object[]) {
    graph.on("GET", "/page-1/posts", { data: posts });
  }

  function instagramMedia(media: object[]) {
    graph.on("GET", "/ig-1/media", { data: media });
  }

  const list = (query = "") => asPlugin(app, token).get(`/plugin/publications${query}`);
  const callsTo = (path: string) => graph.calls.filter((c) => c.path === path);

  it("renvoie les Publications Facebook et Instagram du Site, de la plus récente à la plus ancienne, traduites", async () => {
    facebookPosts([
      {
        id: "page-1_2",
        message: "Nouvelle vitrine",
        created_time: "2026-10-20T09:00:00+0000",
        permalink_url: "https://www.facebook.com/page-1_2",
        full_picture: "https://cdn.fb/vitrine-1.jpg",
        attachments: {
          data: [
            {
              subattachments: {
                data: [{ media: { image: { src: "https://cdn.fb/vitrine-1.jpg" } } }, { media: { image: { src: "https://cdn.fb/vitrine-2.jpg" } } }],
              },
            },
          ],
        },
      },
      { id: "page-1_1", message: "Ouverture lundi", created_time: "2026-10-18T08:00:00+0000", permalink_url: "https://www.facebook.com/page-1_1" },
    ]);
    instagramMedia([
      {
        id: "ig-media-2",
        caption: "Les croissants du jour",
        media_type: "CAROUSEL_ALBUM",
        permalink: "https://www.instagram.com/p/abc",
        timestamp: "2026-10-21T07:30:00+0000",
        children: {
          data: [
            { media_type: "IMAGE", media_url: "https://cdn.ig/croissant.jpg" },
            { media_type: "VIDEO", media_url: "https://cdn.ig/four.mp4", thumbnail_url: "https://cdn.ig/four.jpg" },
          ],
        },
      },
      { id: "ig-media-1", media_type: "IMAGE", media_url: "https://cdn.ig/pain.jpg", permalink: "https://www.instagram.com/p/def", timestamp: "2026-10-19T12:00:00+0000" },
    ]);

    const res = await list().expect(200);

    expect(res.body.publications).toEqual([
      {
        id: "ig-media-2",
        network: "instagram",
        resourceId: igId,
        text: "Les croissants du jour",
        images: ["https://cdn.ig/croissant.jpg", "https://cdn.ig/four.jpg"],
        date: "2026-10-21T07:30:00.000Z",
        url: "https://www.instagram.com/p/abc",
      },
      {
        id: "page-1_2",
        network: "facebook",
        resourceId: pageId,
        text: "Nouvelle vitrine",
        images: ["https://cdn.fb/vitrine-1.jpg", "https://cdn.fb/vitrine-2.jpg"],
        date: "2026-10-20T09:00:00.000Z",
        url: "https://www.facebook.com/page-1_2",
      },
      {
        id: "ig-media-1",
        network: "instagram",
        resourceId: igId,
        text: "",
        images: ["https://cdn.ig/pain.jpg"],
        date: "2026-10-19T12:00:00.000Z",
        url: "https://www.instagram.com/p/def",
      },
      {
        id: "page-1_1",
        network: "facebook",
        resourceId: pageId,
        text: "Ouverture lundi",
        images: [],
        date: "2026-10-18T08:00:00.000Z",
        url: "https://www.facebook.com/page-1_1",
      },
    ]);
    expect(res.body).toMatchObject({ page: 1, hasMore: false, unavailable: [] });
    expect(JSON.stringify(res.body)).not.toContain("token");

    // la page est lue avec son jeton de page, le compte Instagram avec le jeton de la personne
    expect(callsTo("/page-1/posts")[0].query.get("access_token")).toBe("page-token");
    expect(callsTo("/ig-1/media")[0].query.get("access_token")).toBe("user-token");
  });

  it("pagine la liste, sans redemander à Meta d'une page à l'autre", async () => {
    await db.resource.delete({ where: { id: igId } });
    facebookPosts(
      [5, 4, 3, 2, 1].map((n) => ({ id: `page-1_${n}`, message: `Post ${n}`, created_time: `2026-10-0${n}T10:00:00+0000`, permalink_url: `https://fb/${n}` })),
    );

    const first = await list("?limit=2").expect(200);
    const third = await list("?limit=2&page=3").expect(200);

    expect(first.body.publications.map((p: { id: string }) => p.id)).toEqual(["page-1_5", "page-1_4"]);
    expect(first.body).toMatchObject({ page: 1, limit: 2, hasMore: true });
    expect(third.body.publications.map((p: { id: string }) => p.id)).toEqual(["page-1_1"]);
    expect(third.body).toMatchObject({ page: 3, hasMore: false });
    expect(callsTo("/page-1/posts")).toHaveLength(1);
  });

  it("deux appels rapprochés ne déclenchent qu'un appel à Meta par Ressource ; passé quelques minutes, on relit", async () => {
    facebookPosts([]);
    instagramMedia([]);

    await list().expect(200);
    await list().expect(200);
    expect(callsTo("/page-1/posts")).toHaveLength(1);
    expect(callsTo("/ig-1/media")).toHaveLength(1);

    const later = Date.now() + 6 * 60 * 1000;
    jest.spyOn(Date, "now").mockReturnValue(later);
    await list().expect(200);
    expect(callsTo("/page-1/posts")).toHaveLength(2);
  });

  it("filtre sur une Ressource du Site", async () => {
    instagramMedia([{ id: "ig-media-1", media_type: "IMAGE", media_url: "https://cdn.ig/1.jpg", permalink: "https://ig/1", timestamp: "2026-10-19T12:00:00+0000" }]);

    const res = await list(`?resourceId=${igId}`).expect(200);

    expect(res.body.publications.map((p: { id: string }) => p.id)).toEqual(["ig-media-1"]);
    expect(callsTo("/page-1/posts")).toHaveLength(0);
  });

  it("refuse une Ressource qui n'est pas rattachée au Site du jeton", async () => {
    await db.resource.update({ where: { id: pageId }, data: { site_id: null } });
    const res = await list(`?resourceId=${pageId}`).expect(422);
    expect(res.body).toMatchObject({ type: "resource-not-attached", resourceIds: [pageId] });
  });

  it("exige social.read sur le Site du jeton (403)", async () => {
    await db.userFeature.deleteMany();
    await givenOverride(db, marieId, "social.publish", "ADD");

    const res = await list().expect(403);
    expect(res.body).toMatchObject({ type: "missing-feature", feature: "social.read" });
  });

  it("une Ressource sans Intégration active renvoie « Intégration expirée », pas une liste vide", async () => {
    await db.integration.update({ where: { id: integrationId }, data: { status: "EXPIRED" } });

    const res = await list().expect(409);

    expect(res.body).toMatchObject({ type: "integration-expired", resourceIds: [pageId, igId] });
    expect(graph.calls).toHaveLength(0);
  });

  it("ne sert pas depuis le cache une Ressource dont l'accès a été retiré", async () => {
    await db.resource.delete({ where: { id: igId } });
    facebookPosts([{ id: "page-1_1", message: "Bonjour", created_time: "2026-10-18T08:00:00+0000", permalink_url: "https://fb/1" }]);
    await list().expect(200);

    await db.integration.update({ where: { id: integrationId }, data: { status: "REVOKED" } });

    await list().expect(409);
  });

  it("écarte un post mal formé sans cacher les autres", async () => {
    await db.resource.delete({ where: { id: igId } });
    facebookPosts([
      { id: "page-1_2", message: "Sans date" },
      { id: "page-1_1", message: "Bonjour", created_time: "2026-10-18T08:00:00+0000", permalink_url: "https://fb/1" },
    ]);

    const res = await list().expect(200);

    expect(res.body.publications.map((p: { id: string }) => p.id)).toEqual(["page-1_1"]);
  });

  it("si une seule Ressource est illisible, les autres s'affichent et elle est signalée", async () => {
    const integrations = app.get(IntegrationsService);
    await db.integrationResource.delete({ where: { integration_id_resource_id: { integration_id: integrationId, resource_id: pageId } } });
    await db.integration.create({
      data: {
        provider: "META",
        external_user_id: "meta-expiree",
        access_token: integrations.encrypt("old"),
        scopes: [],
        status: "EXPIRED",
        client_id: clientA,
        created_by_id: marieId,
        resources: { create: { resource_id: pageId, access_token: integrations.encrypt("old-page") } },
      },
    });
    instagramMedia([{ id: "ig-media-1", media_type: "IMAGE", media_url: "https://cdn.ig/1.jpg", permalink: "https://ig/1", timestamp: "2026-10-19T12:00:00+0000" }]);

    const res = await list().expect(200);

    expect(res.body.publications.map((p: { id: string }) => p.id)).toEqual(["ig-media-1"]);
    expect(res.body.unavailable).toEqual([{ resourceId: pageId, type: "integration-expired" }]);
  });

  it("la connexion Meta demande la lecture du contenu des pages et des comptes Instagram", async () => {
    await givenOverride(db, marieId, "social.manage", "ADD");
    const marie = await loginAs(app, "marie@client-a.fr");

    const res = await marie.get(`/integrations/oauth/connect?clientId=${clientA}`).expect(302);

    const scopes = new URL(res.headers.location).searchParams.get("scope")!.split(",");
    expect(scopes).toEqual(expect.arrayContaining(["pages_read_engagement", "pages_read_user_content", "instagram_basic"]));
  });
});
