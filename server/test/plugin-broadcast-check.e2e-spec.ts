import type { INestApplication } from "@nestjs/common";
import { DatabaseService } from "../src/core/database/database.service";
import { IntegrationsService } from "../src/core/integrations/integrations.service";
import { createTestApp, magicLinks, resetDatabase } from "./support/app";
import { FakeGraph } from "./support/fake-graph";
import { asPlugin, connectPlugin } from "./support/plugin";
import { givenOverride, givenSite } from "./support/rights";

// permissions Meta exigées pour publier sur une page Facebook (photos comprises)
const PAGE_PUBLISH_SCOPES = ["pages_manage_posts", "pages_read_engagement", "pages_show_list"];
const MB = 1024 * 1024;

type Image = { url: string; mimeType: string; width: number; height: number; size: number };
type Target = { resourceId: number; text: string };

/**
 * Refus prévisibles : ce qu'on sait refusé sans appeler Meta. La vérification les liste par
 * Ressource cible ; une Diffusion qui en contient un est bloquée en entier, sans rien envoyer.
 * Marie (Client A) a social.publish sur site-a.fr ; la page « page-1 » y est rattachée.
 */
describe("Refus prévisibles avant Diffusion (HTTP)", () => {
  let app: INestApplication;
  let db: DatabaseService;
  const graph = new FakeGraph();

  let clientA: number;
  let siteA: number;
  let marieId: number;
  let pageId: number;
  let token: string;

  const ARTICLE = { id: "42", url: "https://site-a.fr/2026/10/portes-ouvertes" };
  /** Une image de la médiathèque WordPress, décrite par le Plugin WP. */
  const jpeg = (name = "photo.jpg", size = 100_000, mimeType = "image/jpeg"): Image => ({
    url: `https://site-a.fr/wp-content/uploads/${name}`,
    mimeType,
    width: 1200,
    height: 800,
    size,
  });

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

    pageId = await givenResource("page-1", [{ externalUserId: "meta-marie", pageToken: "page-token" }]);
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

  /** Une Ressource rattachée à site-a.fr, atteinte par ces Intégrations du Client A. */
  async function givenResource(
    externalId: string,
    accesses: { externalUserId: string; pageToken: string; status?: "ACTIVE" | "EXPIRED"; scopes?: string[] }[],
    type: "FACEBOOK_PAGE" | "AD_ACCOUNT" = "FACEBOOK_PAGE",
  ) {
    const integrations = app.get(IntegrationsService);
    const resource = await db.resource.create({
      data: { provider: "META", type, external_id: externalId, name: externalId, site_id: siteA },
    });
    for (const access of accesses) {
      await db.integration.create({
        data: {
          provider: "META",
          external_user_id: access.externalUserId,
          access_token: integrations.encrypt("user-token"),
          scopes: access.scopes ?? PAGE_PUBLISH_SCOPES,
          status: access.status ?? "ACTIVE",
          client_id: clientA,
          created_by_id: marieId,
          resources: { create: { resource_id: resource.id, access_token: integrations.encrypt(access.pageToken) } },
        },
      });
    }
    return resource.id;
  }

  /** La même requête JSON pour la vérification et pour la Diffusion. */
  function send(path: "/plugin/broadcasts/check" | "/plugin/broadcasts", targets: Target[], images: Image[] = []) {
    return asPlugin(app, token).post(path).send({ actualite: ARTICLE, images, targets });
  }
  const check = (targets: Target[], images: Image[] = []) => send("/plugin/broadcasts/check", targets, images);
  const broadcast = (targets: Target[], images: Image[] = []) => send("/plugin/broadcasts", targets, images);

  /** Chaque refus prévisible : la mise en place, la Diffusion qui le déclenche, et ce qu'on attend. */
  const REFUSALS: [string, { setup?: () => Promise<number | void>; text?: string; images?: Image[]; refusal: object }][] = [
    [
      "aucune Intégration active vers la Ressource",
      {
        setup: () => db.integration.updateMany({ data: { status: "EXPIRED" } }).then(() => undefined),
        refusal: { type: "integration-expired" },
      },
    ],
    [
      "permission Meta de publication non accordée",
      {
        setup: () => db.integration.updateMany({ data: { scopes: ["pages_show_list", "pages_read_engagement"] } }).then(() => undefined),
        refusal: { type: "permission-missing", requiredScopes: PAGE_PUBLISH_SCOPES },
      },
    ],
    ["texte trop long pour Facebook", { text: "a".repeat(63_207), refusal: { type: "text-too-long", maxLength: 63_206 } }],
    [
      "trop d'images pour un post Facebook",
      { images: Array.from({ length: 11 }, (_, i) => jpeg(`photo-${i}.jpg`)), refusal: { type: "too-many-images", maxImages: 10 } },
    ],
    [
      "format d'image non accepté par Facebook",
      {
        images: [jpeg(), jpeg("anime.webp", 100_000, "image/webp")],
        refusal: { type: "image-format-unsupported", images: [jpeg("anime.webp").url] },
      },
    ],
    [
      "image trop lourde pour Facebook",
      { images: [jpeg("lourde.jpg", 4 * MB + 1)], refusal: { type: "image-too-large", maxBytes: 4 * MB, images: [jpeg("lourde.jpg").url] } },
    ],
    [
      "Ressource qui ne se diffuse pas (compte publicitaire)",
      {
        setup: () => givenResource("act-1", [{ externalUserId: "meta-marie-ads", pageToken: "t" }], "AD_ACCOUNT"),
        refusal: { type: "resource-type-unsupported" },
      },
    ],
  ];

  describe("vérification sans envoi", () => {
    it("ne renvoie aucun refus pour une Diffusion valide, sans rien envoyer ni tracer", async () => {
      const res = await check([{ resourceId: pageId, text: "Portes ouvertes samedi !" }], [jpeg()]).expect(200);

      expect(res.body).toEqual({ ok: true, targets: [{ resourceId: pageId, refusals: [] }] });
      expect(graph.calls).toHaveLength(0);
      expect(await db.publication.count()).toBe(0);
    });

    it.each(REFUSALS)("signale le refus : %s, sans appeler Meta", async (_, { setup, text, images, refusal }) => {
      const resourceId = (await setup?.()) ?? pageId;

      const res = await check([{ resourceId, text: text ?? "Bonjour" }], images).expect(200);

      expect(res.body.ok).toBe(false);
      expect(res.body.targets).toEqual([{ resourceId, refusals: [expect.objectContaining({ ...refusal, detail: expect.any(String) })] }]);
      expect(graph.calls).toHaveLength(0);
      expect(await db.publication.count()).toBe(0);
    });

    it("liste les refus Ressource par Ressource : une cible valide n'en a aucun", async () => {
      const expiredPage = await givenResource("page-2", [{ externalUserId: "meta-ancien", pageToken: "t", status: "EXPIRED" }]);

      const res = await check([
        { resourceId: pageId, text: "Bonjour" },
        { resourceId: expiredPage, text: "a".repeat(63_207) },
      ]).expect(200);

      expect(res.body.ok).toBe(false);
      expect(res.body.targets).toEqual([
        { resourceId: pageId, refusals: [] },
        {
          resourceId: expiredPage,
          refusals: [expect.objectContaining({ type: "integration-expired" }), expect.objectContaining({ type: "text-too-long" })],
        },
      ]);
    });

    it("exige social.publish sur le Site du jeton (403)", async () => {
      await db.userFeature.deleteMany();
      await givenOverride(db, marieId, "social.read", "ADD");

      const res = await check([{ resourceId: pageId, text: "Bonjour" }]).expect(403);

      expect(res.body).toMatchObject({ type: "missing-feature", feature: "social.publish" });
    });

    it("refuse une Ressource non rattachée au Site du jeton (422), comme la Diffusion", async () => {
      const res = await check([{ resourceId: 999, text: "Bonjour" }]).expect(422);

      expect(res.body).toMatchObject({ type: "resource-not-attached", resourceIds: [999] });
    });
  });

  describe("Diffusion", () => {
    it.each(REFUSALS)("est bloquée en entier par le refus : %s, sans rien envoyer ni tracer", async (_, { setup, text, images, refusal }) => {
      const resourceId = (await setup?.()) ?? pageId;
      // une seconde cible valide : elle ne part pas non plus
      const targets = [
        { resourceId, text: text ?? "Bonjour" },
        ...(resourceId === pageId ? [] : [{ resourceId: pageId, text: "Bonjour" }]),
      ];

      const res = await broadcast(targets, images).expect(422);

      expect(res.headers["content-type"]).toContain("application/problem+json");
      expect(res.body).toMatchObject({ type: "broadcast-refused", status: 422 });
      expect(res.body.targets).toContainEqual({ resourceId, refusals: [expect.objectContaining(refusal)] });
      expect(graph.calls).toHaveLength(0);
      expect(await db.publication.count()).toBe(0);
    });

    it("sans refus, publie avec une Intégration qui a la permission de publier", async () => {
      // deux Intégrations actives : la première n'a pas accordé la publication
      await db.integrationResource.deleteMany();
      await db.integration.deleteMany();
      await db.resource.delete({ where: { id: pageId } });
      pageId = await givenResource("page-1", [
        { externalUserId: "meta-sans-publication", pageToken: "jeton-lecture", scopes: ["pages_show_list"] },
        { externalUserId: "meta-avec-publication", pageToken: "jeton-publication" },
      ]);
      graph.on("POST", "/page-1/feed", { id: "page-1_777" });
      graph.on("GET", "/page-1_777", { id: "page-1_777", permalink_url: "https://www.facebook.com/page-1_777" });

      const res = await broadcast([{ resourceId: pageId, text: "Bonjour" }]).expect(201);

      expect(res.body.publications[0]).toMatchObject({ status: "SUCCEEDED" });
      const feed = graph.calls.find((c) => c.path === "/page-1/feed")!;
      expect(feed.query.get("access_token")).toBe("jeton-publication");
    });
  });
});
