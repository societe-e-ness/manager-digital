import type { INestApplication } from "@nestjs/common";
import { DatabaseService } from "../src/core/database/database.service";
import { IntegrationsService } from "../src/core/integrations/integrations.service";
import { createTestApp, magicLinks, resetDatabase } from "./support/app";
import { loginAs } from "./support/auth";
import { FakeGraph } from "./support/fake-graph";
import { asPlugin, connectPlugin } from "./support/plugin";
import { givenOverride, givenSite } from "./support/rights";

const PAGE_PUBLISH_SCOPES = ["pages_manage_posts", "pages_read_engagement", "pages_show_list"];
const INSTAGRAM_PUBLISH_SCOPES = ["instagram_basic", "instagram_content_publish", "pages_read_engagement"];
const ALL_SCOPES = [...new Set([...PAGE_PUBLISH_SCOPES, ...INSTAGRAM_PUBLISH_SCOPES])];
const MB = 1024 * 1024;

type Image = { url: string; mimeType: string; width: number; height: number; size: number };
type Target = { resourceId: number; text: string; format?: string };

/** Une image de la médiathèque WordPress, décrite par le Plugin WP (par défaut : un JPEG 4:5 valable partout). */
const image = (name = "photo.jpg", over: Partial<Image> = {}): Image => ({
  url: `https://site-a.fr/wp-content/uploads/2026/11/${name}`,
  mimeType: "image/jpeg",
  width: 1080,
  height: 1350,
  size: 500_000,
  ...over,
});

/**
 * Diffuser sur Instagram, en post (une image ou un carrousel) ou en story, depuis le Plugin WP.
 * Les images sont des URL publiques de la médiathèque : Meta va les chercher lui-même.
 * Marie (Client A) a social.publish sur site-a.fr ; le compte Instagram « ig-1 » et la page
 * Facebook « page-1 » y sont rattachés.
 */
describe("Diffusion sur Instagram (HTTP)", () => {
  let app: INestApplication;
  let db: DatabaseService;
  const graph = new FakeGraph();

  let clientA: number;
  let siteA: number;
  let marieId: number;
  let igId: number;
  let pageId: number;
  let token: string;

  const ARTICLE = { id: "42", url: "https://site-a.fr/2026/10/portes-ouvertes" };

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

    // une Intégration de Marie mène à sa page et au compte Instagram lié (sans jeton de page pour celui-ci)
    const integrations = app.get(IntegrationsService);
    const marie = await givenIntegration("meta-marie", "jeton-marie");
    pageId = (await db.resource.create({ data: { provider: "META", type: "FACEBOOK_PAGE", external_id: "page-1", name: "Page", site_id: siteA } })).id;
    igId = (
      await db.resource.create({ data: { provider: "META", type: "INSTAGRAM_ACCOUNT", external_id: "ig-1", name: "@boulangerie", site_id: siteA } })
    ).id;
    await db.integrationResource.create({ data: { integration_id: marie.id, resource_id: pageId, access_token: integrations.encrypt("page-marie") } });
    await db.integrationResource.create({ data: { integration_id: marie.id, resource_id: igId } });

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

  async function givenIntegration(externalUserId: string, userToken: string, scopes = ALL_SCOPES) {
    return db.integration.create({
      data: {
        provider: "META",
        external_user_id: externalUserId,
        access_token: app.get(IntegrationsService).encrypt(userToken),
        scopes,
        client_id: clientA,
        created_by_id: marieId,
      },
    });
  }

  function send(path: "/plugin/broadcasts" | "/plugin/broadcasts/check", targets: Target[], images: Image[] = []) {
    return asPlugin(app, token).post(path).send({ actualite: ARTICLE, images, targets });
  }
  const broadcast = (targets: Target[], images: Image[] = []) => send("/plugin/broadcasts", targets, images);
  const check = (targets: Target[], images: Image[] = []) => send("/plugin/broadcasts/check", targets, images);

  /** Instagram accepte : conteneur créé, prêt, publié, et son lien. */
  function instagramAccepts(mediaId = "media-1") {
    graph.on("POST", "/ig-1/media", { id: "container-1" });
    graph.on("GET", "/container-1", { id: "container-1", status_code: "FINISHED" });
    graph.on("POST", "/ig-1/media_publish", { id: mediaId });
    graph.on("GET", `/${mediaId}`, { id: mediaId, permalink: `https://www.instagram.com/p/${mediaId}/` });
  }

  const calls = (method: string, path: string) => graph.calls.filter((c) => c.method === method && c.path === path);
  const form = (call: { body?: string }) => new URLSearchParams(call.body);

  describe("publication", () => {
    it("un post à une image : conteneur avec l'image et la légende, attente, publication, lien tracé", async () => {
      instagramAccepts();

      const res = await broadcast([{ resourceId: igId, text: "Portes ouvertes samedi ! #pain" }], [image("facade.jpg")]).expect(201);

      const [container] = calls("POST", "/ig-1/media");
      expect(container.query.get("access_token")).toBe("jeton-marie"); // le jeton de la personne, pas un jeton de page
      expect(form(container).get("image_url")).toBe(image("facade.jpg").url);
      expect(form(container).get("caption")).toBe("Portes ouvertes samedi ! #pain"); // le lien n'y est pas ajouté
      expect(calls("GET", "/container-1")).toHaveLength(1);
      expect(form(calls("POST", "/ig-1/media_publish")[0]).get("creation_id")).toBe("container-1");

      expect(res.body.publications).toEqual([
        expect.objectContaining({
          resource_id: igId,
          format: "post",
          status: "SUCCEEDED",
          network_post_id: "media-1",
          network_url: "https://www.instagram.com/p/media-1/",
          images: [image("facade.jpg")],
        }),
      ]);
    });

    it("un carrousel : un conteneur par image (sans légende), puis le carrousel avec la légende", async () => {
      instagramAccepts();

      await broadcast([{ resourceId: igId, text: "En images" }], [image("a.jpg"), image("b.jpg")]).expect(201);

      const containers = calls("POST", "/ig-1/media").map(form);
      expect(containers).toHaveLength(3);
      for (const [i, name] of ["a.jpg", "b.jpg"].entries()) {
        expect(containers[i].get("image_url")).toBe(image(name).url);
        expect(containers[i].get("is_carousel_item")).toBe("true");
        expect(containers[i].get("caption")).toBeNull();
      }
      expect(containers[2].get("media_type")).toBe("CAROUSEL");
      expect(containers[2].get("children")).toBe("container-1,container-1");
      expect(containers[2].get("caption")).toBe("En images");
      expect(calls("POST", "/ig-1/media_publish")).toHaveLength(1);
    });

    it("une story : une image, sans légende", async () => {
      instagramAccepts();

      const res = await broadcast([{ resourceId: igId, text: "", format: "story" }], [image("story.jpg", { width: 1080, height: 1920 })]).expect(201);

      const [container] = calls("POST", "/ig-1/media").map(form);
      expect(container.get("media_type")).toBe("STORIES");
      expect(container.get("image_url")).toBe(image("story.jpg").url);
      expect(container.get("caption")).toBeNull();
      expect(res.body.publications[0]).toMatchObject({ format: "story", status: "SUCCEEDED" });
    });

    it("Facebook et Instagram à la fois : une Publication par Ressource ; Facebook reçoit ses photos par URL", async () => {
      instagramAccepts();
      graph.on("POST", "/page-1/photos", { id: "photo-1" });
      graph.on("POST", "/page-1/feed", { id: "page-1_777" });
      graph.on("GET", "/page-1_777", { id: "page-1_777", permalink_url: "https://www.facebook.com/page-1_777" });

      const res = await broadcast(
        [
          { resourceId: pageId, text: "Bonjour Facebook" },
          { resourceId: igId, text: "Bonjour Instagram" },
        ],
        [image("facade.jpg")],
      ).expect(201);

      expect(res.body.publications).toEqual([
        expect.objectContaining({ resource_id: pageId, status: "SUCCEEDED" }),
        expect.objectContaining({ resource_id: igId, status: "SUCCEEDED" }),
      ]);
      const [photo] = calls("POST", "/page-1/photos");
      expect(photo.query.get("access_token")).toBe("page-marie");
      expect(form(photo).get("url")).toBe(image("facade.jpg").url);
      expect(form(photo).get("published")).toBe("false");
    });

    it("un conteneur refusé par Instagram : Publication échouée (content-rejected), rien n'est publié", async () => {
      graph.on("POST", "/ig-1/media", { id: "container-1" });
      graph.on("GET", "/container-1", { id: "container-1", status_code: "ERROR", status: "Error: 2207009" });

      const res = await broadcast([{ resourceId: igId, text: "Bonjour" }], [image()]).expect(201);

      expect(res.body.publications[0]).toMatchObject({ status: "FAILED", error_type: "content-rejected" });
      expect(calls("POST", "/ig-1/media_publish")).toHaveLength(0);
    });

    it("jeton de la personne refusé : son Intégration expire et la Diffusion passe par une autre", async () => {
      const paul = await givenIntegration("meta-paul", "jeton-paul");
      await db.integrationResource.create({ data: { integration_id: paul.id, resource_id: igId } });
      graph.on("POST", "/ig-1/media", { error: { message: "Error validating access token", code: 190 } }, 400, { access_token: "jeton-marie" });
      instagramAccepts();

      const res = await broadcast([{ resourceId: igId, text: "Bonjour" }], [image()]).expect(201);

      expect(res.body.publications[0]).toMatchObject({ status: "SUCCEEDED" });
      expect(calls("POST", "/ig-1/media").map((c) => c.query.get("access_token"))).toEqual(["jeton-marie", "jeton-paul"]);
      expect((await db.integration.findFirstOrThrow({ where: { external_user_id: "meta-marie" } })).status).toBe("EXPIRED");
    });

    it("la relance réutilise les images enregistrées : le Plugin WP n'a rien à joindre", async () => {
      graph.on("POST", "/ig-1/media", { error: { message: "Service unavailable", code: 2 } }, 500);
      const [failed] = (await broadcast([{ resourceId: igId, text: "Bonjour" }], [image("facade.jpg")]).expect(201)).body.publications;
      expect(failed).toMatchObject({ status: "FAILED", error_type: "network-unavailable" });
      graph.reset();
      graph.calls.length = 0;
      instagramAccepts();

      const res = await asPlugin(app, token).post(`/plugin/publications/${failed.id}/retry`).expect(200);

      expect(res.body).toMatchObject({ id: failed.id, status: "SUCCEEDED" });
      expect(form(calls("POST", "/ig-1/media")[0]).get("image_url")).toBe(image("facade.jpg").url);
    });

    it("la connexion Meta demande la permission de publier sur Instagram", async () => {
      const agency = await db.user.create({ data: { email: "alice@agence.fr", type: "AGENCY" } });
      await givenOverride(db, agency.id, "social.manage", "ADD");
      const alice = await loginAs(app, "alice@agence.fr");

      const res = await alice.get(`/integrations/oauth/connect?clientId=${clientA}`).expect(302);

      const scopes = new URL(res.headers.location).searchParams.get("scope")?.split(",");
      expect(scopes).toEqual(expect.arrayContaining(INSTAGRAM_PUBLISH_SCOPES));
    });
  });

  describe("refus prévisibles", () => {
    const REFUSALS: [string, { target?: Partial<Target>; images?: Image[]; setup?: () => Promise<unknown>; refusal: object }][] = [
      ["post sans image", { images: [], refusal: { type: "image-required" } }],
      ["image qui n'est pas un JPEG", { images: [image("logo.png", { mimeType: "image/png" })], refusal: { type: "image-format-unsupported" } }],
      ["image de plus de 8 Mo", { images: [image("lourde.jpg", { size: 8 * MB + 1 })], refusal: { type: "image-too-large", maxBytes: 8 * MB } }],
      [
        "proportions hors de 4:5 à 1,91:1 pour un post",
        { images: [image("verticale.jpg", { width: 1080, height: 1920 })], refusal: { type: "image-aspect-ratio", images: [image("verticale.jpg").url] } },
      ],
      ["légende de plus de 2 200 caractères", { target: { text: "a".repeat(2_201) }, refusal: { type: "text-too-long", maxLength: 2_200 } }],
      [
        "plus de 30 hashtags",
        { target: { text: Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(" ") }, refusal: { type: "too-many-hashtags", maxHashtags: 30 } },
      ],
      [
        "plus de 20 mentions",
        { target: { text: Array.from({ length: 21 }, (_, i) => `@ami${i}`).join(" ") }, refusal: { type: "too-many-mentions", maxMentions: 20 } },
      ],
      [
        "carrousel de plus de 10 images",
        { images: Array.from({ length: 11 }, (_, i) => image(`p${i}.jpg`)), refusal: { type: "too-many-images", maxImages: 10 } },
      ],
      [
        "story de plus d'une image",
        { target: { text: "", format: "story" }, images: [image("a.jpg"), image("b.jpg")], refusal: { type: "too-many-images", maxImages: 1 } },
      ],
      ["story avec du texte", { target: { text: "Bonjour", format: "story" }, refusal: { type: "story-text-unsupported" } }],
      [
        "permission de publier sur Instagram non accordée",
        {
          setup: () => db.integration.updateMany({ data: { scopes: PAGE_PUBLISH_SCOPES } }),
          refusal: { type: "permission-missing", requiredScopes: INSTAGRAM_PUBLISH_SCOPES },
        },
      ],
      ["format inconnu", { target: { format: "reel" }, refusal: { type: "format-unsupported", supportedFormats: ["post", "story"] } }],
    ];

    it.each(REFUSALS)("vérification : %s, sans appeler Meta", async (_, { target, images, setup, refusal }) => {
      await setup?.();

      const res = await check([{ resourceId: igId, text: "Bonjour", ...target }], images ?? [image()]).expect(200);

      expect(res.body.ok).toBe(false);
      expect(res.body.targets).toEqual([{ resourceId: igId, refusals: [expect.objectContaining({ ...refusal, detail: expect.any(String) })] }]);
      expect(graph.calls).toHaveLength(0);
    });

    it("bloque la Diffusion en entier, Facebook compris, sans rien envoyer ni tracer", async () => {
      const res = await broadcast(
        [
          { resourceId: pageId, text: "Bonjour" },
          { resourceId: igId, text: "Bonjour" },
        ],
        [],
      ).expect(422);

      expect(res.body).toMatchObject({ type: "broadcast-refused" });
      expect(res.body.targets).toEqual([
        { resourceId: pageId, refusals: [] },
        { resourceId: igId, refusals: [expect.objectContaining({ type: "image-required" })] },
      ]);
      expect(graph.calls).toHaveLength(0);
      expect(await db.publication.count()).toBe(0);
    });

    it("ne refuse pas à tort : proportions arrondies (1200 × 628), ancre d'URL, type MIME en majuscules", async () => {
      const text = `${Array.from({ length: 30 }, (_, i) => `#tag${i}`).join(" ")} https://site-a.fr/actu#commentaires contact@site-a.fr`;

      const res = await check([{ resourceId: igId, text }], [image("og.jpg", { width: 1200, height: 628, mimeType: "image/JPEG" })]).expect(200);

      expect(res.body).toEqual({ ok: true, targets: [{ resourceId: igId, refusals: [] }] });
    });

    it("une story vers une page Facebook n'est pas (encore) prise en charge", async () => {
      const res = await check([{ resourceId: pageId, text: "", format: "story" }], [image()]).expect(200);

      expect(res.body.targets[0].refusals).toEqual([expect.objectContaining({ type: "format-unsupported", supportedFormats: ["post"] })]);
    });

    it.each([
      ["une URL non HTTPS", { url: "http://site-a.fr/photo.jpg" }],
      ["une largeur absente", { width: undefined }],
      ["un poids négatif", { size: -1 }],
    ])("refuse une image mal décrite : %s (400)", async (_, over) => {
      const res = await check([{ resourceId: igId, text: "Bonjour" }], [{ ...image(), ...over } as Image]).expect(400);

      expect(res.body).toMatchObject({ type: "broadcast-invalid-request" });
    });
  });
});
