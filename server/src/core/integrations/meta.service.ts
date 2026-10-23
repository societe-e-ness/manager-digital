import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac } from "node:crypto";
import type { Integration } from "../../generated/prisma/client";
import { IntegrationsService, type ResourceInput } from "./integrations.service";

const GRAPH_URL = "https://graph.facebook.com/v21.0";

/** Une Publication lue chez Meta, traduite dans notre vocabulaire. */
export interface NetworkPost {
  id: string; // identifiant côté réseau
  network: "facebook" | "instagram";
  text: string;
  images: string[]; // URL des images (vignette pour une vidéo)
  date: string; // ISO 8601
  url: string; // lien vers la Publication d'origine
}
const STATE_TTL_MS = 10 * 60 * 1000;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Le seul fichier du projet qui parle à Meta.
 *
 *  1. OAuth : URL de consentement, échange du code, identité, rafraîchissement du jeton
 *  2. State signé : empêche de rattacher un compte Meta au mauvais client
 *  3. Graph API : inventaire des ressources, lecture et publication sur une page, lecture Instagram,
 *     métriques de campagnes
 */
@Injectable()
export class MetaService {
  constructor(
    private readonly config: ConfigService,
    private readonly integrations: IntegrationsService,
  ) {}

  // =========================================================================
  // 1. OAuth
  // =========================================================================

  /** À déclarer dans l'app Meta, pour chaque environnement. */
  get redirectUri() {
    return `${this.config.getOrThrow("APP_PUBLIC_URL")}/integrations/oauth/callback`;
  }

  /** Étape 1 : l'URL vers laquelle on envoie le client pour donner son accord. */
  buildAuthorizationUrl(state: string) {
    if (!this.config.get("META_ENABLED")) throw new Error("Meta est désactivé dans la configuration");

    const params = new URLSearchParams({
      client_id: this.config.getOrThrow("META_APP_ID"),
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: [
        "ads_read",
        "business_management",
        "pages_show_list",
        "pages_read_engagement",
        "pages_read_user_content", // lecture du contenu des pages
        "pages_manage_posts", // publication sur les pages
        "instagram_basic", // lecture des comptes Instagram et de leurs médias
      ].join(","),
      state,
    });
    return `https://www.facebook.com/v21.0/dialog/oauth?${params}`;
  }

  /**
   * Étape 2 : le code reçu au callback est échangé contre un jeton.
   * Meta donne d'abord un jeton court (~1 h), qu'on échange contre un jeton de 60 jours.
   */
  async exchangeCode(code: string) {
    const short = await this.tokenRequest({ code, redirect_uri: this.redirectUri });
    return this.exchangeForLongLivedToken(short.access_token);
  }

  /** Qui est la personne derrière ce jeton, et quelles permissions a-t-elle réellement accordées. */
  async fetchIdentity(accessToken: string) {
    const me = await this.graphRaw(accessToken, "/me", { fields: "id,name" });
    const permissions = await this.graphRaw(accessToken, "/me/permissions");
    return {
      externalUserId: me.id as string,
      name: me.name as string,
      scopes: (permissions.data ?? [])
        .filter((p: any) => p.status === "granted")
        .map((p: any) => p.permission as string),
    };
  }

  /**
   * Rafraîchissement : Meta n'a pas de refresh_token. On ré-échange le jeton
   * de 60 jours contre un nouveau, tant qu'il est encore valide.
   */
  async refresh(integration: Integration) {
    const current = this.integrations.decrypt(integration.access_token);
    const fresh = await this.exchangeForLongLivedToken(current);
    await this.integrations.saveToken(integration.id, fresh.accessToken, fresh.expiresAt);
    return fresh.accessToken;
  }

  private async exchangeForLongLivedToken(accessToken: string) {
    const data = await this.tokenRequest({ grant_type: "fb_exchange_token", fb_exchange_token: accessToken });
    const expiresIn = Number(data.expires_in ?? 60 * 24 * 3600); // 60 jours si Meta ne précise pas
    return {
      accessToken: data.access_token as string,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    };
  }

  /** Appel à l'endpoint de jetons de Meta, avec l'identité de notre application. */
  private async tokenRequest(query: Record<string, string>) {
    const params = new URLSearchParams({
      ...query,
      client_id: this.config.getOrThrow("META_APP_ID"),
      client_secret: this.config.getOrThrow("META_APP_SECRET"),
    });
    const res = await fetch(`${GRAPH_URL}/oauth/access_token?${params}`);
    if (!res.ok) throw new Error(`Échec OAuth Meta (${res.status}) : ${await res.text()}`);
    return res.json();
  }

  // =========================================================================
  // 2. State signé (anti-CSRF)
  //    Format : "<payload base64url>.<signature HMAC base64url>"
  // =========================================================================

  signState(payload: { clientId: number | null; userId: number }) {
    const encoded = Buffer.from(JSON.stringify({ ...payload, expiresAt: Date.now() + STATE_TTL_MS })).toString("base64url");
    return `${encoded}.${this.hmac(encoded)}`;
  }

  /** Renvoie le contenu du state, ou lève s'il est forgé ou périmé. */
  verifyState(state: string | undefined) {
    const [encoded, signature] = (state ?? "").split(".");
    if (!encoded || signature !== this.hmac(encoded)) throw new UnauthorizedException("State OAuth invalide");

    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (parsed.expiresAt < Date.now()) throw new UnauthorizedException("State OAuth expiré, relancer la connexion");
    return { clientId: parsed.clientId as number | null, userId: parsed.userId as number };
  }

  private hmac(payload: string) {
    const key = Buffer.from(this.config.getOrThrow("ENCRYPTION_KEY"), "base64");
    return createHmac("sha256", key).update(payload).digest("base64url");
  }

  // =========================================================================
  // 3. Graph API
  // =========================================================================

  /**
   * Inventaire de ce que le jeton permet d'atteindre : comptes publicitaires,
   * pages Facebook (avec leur jeton propre) et comptes Instagram rattachés aux pages.
   */
  async fetchResources(integration: Integration): Promise<ResourceInput[]> {
    // Liste complète : la synchronisation retire les liens vers ce qui n'est pas renvoyé.
    const adAccounts = await this.graphList(integration, "/me/adaccounts", { fields: "id,name,currency", limit: "100" });
    const pages = await this.graphList(integration, "/me/accounts", {
      fields: "id,name,access_token,category,instagram_business_account{id,username}",
      limit: "100",
    });

    const resources: ResourceInput[] = [];

    for (const a of adAccounts) {
      resources.push({ type: "AD_ACCOUNT", externalId: a.id, name: a.name ?? a.id, metadata: { currency: a.currency } });
    }
    for (const p of pages) {
      resources.push({ type: "FACEBOOK_PAGE", externalId: p.id, name: p.name, accessToken: p.access_token, metadata: { category: p.category } });
      if (p.instagram_business_account) {
        const ig = p.instagram_business_account;
        resources.push({ type: "INSTAGRAM_ACCOUNT", externalId: ig.id, name: ig.username ?? ig.id, parentExternalId: p.id });
      }
    }
    return resources;
  }

  /** Les dernières Publications d'une page Facebook (jeton de page), de la plus récente à la plus ancienne. */
  async fetchPagePosts(integration: Integration, pageToken: string, pageExternalId: string, limit: number): Promise<NetworkPost[]> {
    const data = await this.graph(
      integration,
      `/${pageExternalId}/posts`,
      { fields: "id,message,created_time,permalink_url,full_picture,attachments{media,subattachments}", limit: String(limit) },
      pageToken,
    );
    return (data.data ?? []).flatMap((post: any) => {
      const date = metaDate(post.created_time);
      if (!date) return []; // un post mal formé est écarté, pas toute la page
      // un album : ses sous-pièces jointes ; sinon la pièce jointe, ou à défaut l'image principale
      const attachment = post.attachments?.data?.[0];
      const pieces = attachment?.subattachments?.data ?? (attachment ? [attachment] : []);
      const images = pieces.map((p: any) => p.media?.image?.src).filter(Boolean);
      return [
        {
          id: post.id,
          network: "facebook" as const,
          text: post.message ?? "",
          images: images.length > 0 ? images : post.full_picture ? [post.full_picture] : [],
          date,
          url: post.permalink_url,
        },
      ];
    });
  }

  /** Les derniers médias d'un compte Instagram (jeton de la personne), du plus récent au plus ancien. */
  async fetchInstagramMedia(integration: Integration, igExternalId: string, limit: number): Promise<NetworkPost[]> {
    const data = await this.graph(integration, `/${igExternalId}/media`, {
      fields: "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,children{media_type,media_url,thumbnail_url}",
      limit: String(limit),
    });
    // une vidéo n'a pas d'image : on prend sa vignette
    const image = (m: any) => (m.media_type === "VIDEO" ? m.thumbnail_url : m.media_url);
    return (data.data ?? []).flatMap((media: any) => {
      const date = metaDate(media.timestamp);
      if (!date) return []; // un média mal formé est écarté, pas tout le compte
      return [
        {
          id: media.id,
          network: "instagram" as const,
          text: media.caption ?? "",
          images: (media.media_type === "CAROUSEL_ALBUM" ? (media.children?.data ?? []) : [media]).map(image).filter(Boolean),
          date,
          url: media.permalink,
        },
      ];
    });
  }

  /**
   * Publie sur une page Facebook avec son jeton de page. Sans image : un post avec le lien (aperçu).
   * Avec images : chacune est envoyée en photo non publiée, puis un post les regroupe ; Facebook
   * n'accepte alors pas de lien joint, il va dans le texte. Renvoie l'identifiant et le lien du post.
   */
  async publishToPage(
    integration: Integration,
    pageToken: string,
    pageExternalId: string,
    post: { message: string; link: string; images: { buffer: Buffer; mimetype: string; filename: string }[] },
  ) {
    const body = new URLSearchParams();
    if (post.images.length === 0) {
      body.set("message", post.message);
      body.set("link", post.link);
    } else {
      body.set("message", [post.message, post.link].filter(Boolean).join("\n\n"));
      const photos = await Promise.all(
        post.images.map((image) => {
          const form = new FormData();
          form.set("source", new Blob([new Uint8Array(image.buffer)], { type: image.mimetype }), image.filename);
          form.set("published", "false");
          return this.graph(integration, `/${pageExternalId}/photos`, {}, pageToken, form);
        }),
      );
      photos.forEach((photo, i) => body.set(`attached_media[${i}]`, JSON.stringify({ media_fbid: photo.id })));
    }

    const created = await this.graph(integration, `/${pageExternalId}/feed`, {}, pageToken, body);
    const postId = created.id as string;
    // Le post est en ligne : un échec de la lecture de son lien ne doit pas le faire passer pour raté
    // (l'utilisateur relancerait, et le publierait deux fois).
    const url = await this.graph(integration, `/${postId}`, { fields: "permalink_url" }, pageToken)
      .then((details) => details.permalink_url as string)
      .catch(() => `https://www.facebook.com/${postId}`);
    return { postId, url };
  }

  /**
   * Métriques par campagne d'un compte publicitaire sur une période, traduites dans notre vocabulaire.
   * `integration` : n'importe quelle Intégration ACTIVE qui mène au compte (voir findActiveResources).
   */
  async fetchCampaignMetrics(integration: Integration, adAccountExternalId: string, from: Date, to: Date) {
    const data = await this.graph(integration, `/${adAccountExternalId}/insights`, {
      level: "campaign",
      fields: "campaign_id,campaign_name,impressions,clicks,ctr,spend,account_currency,actions,purchase_roas",
      time_range: JSON.stringify({ since: isoDate(from), until: isoDate(to) }),
      limit: "500",
    });

    return (data.data ?? []).map((row: any) => ({
      campaignId: row.campaign_id as string,
      campaignName: row.campaign_name as string,
      impressions: Number(row.impressions ?? 0),
      clicks: Number(row.clicks ?? 0),
      ctr: Number(row.ctr ?? 0) / 100, // Meta donne un pourcentage, on veut un ratio
      cost: Math.round(Number(row.spend ?? 0) * 100), // Meta donne des euros, on veut des centimes
      currency: (row.account_currency ?? "EUR") as string,
      conversions: (row.actions ?? [])
        .filter((a: any) => a.action_type === "omni_purchase" || a.action_type === "lead")
        .reduce((sum: number, a: any) => sum + Number(a.value), 0),
      roas: row.purchase_roas?.[0] ? Number(row.purchase_roas[0].value) : null,
    }));
  }

  /**
   * Appel Graph avec le jeton utilisateur de l'intégration, rafraîchi s'il expire bientôt.
   * Marque l'intégration EXPIRED si Meta répond que le jeton n'est plus bon.
   * Pour une page, passer son jeton propre déchiffré en `tokenOverride`. Avec `body` : un POST.
   */
  private async graph(
    integration: Integration,
    path: string,
    query: Record<string, string> = {},
    tokenOverride?: string,
    body?: URLSearchParams | FormData,
  ) {
    const token = tokenOverride ?? (await this.validAccessToken(integration));
    try {
      return await this.graphRaw(token, path, query, body);
    } catch (e) {
      // un jeton de page refusé ne dit rien du jeton de la personne : seul ce dernier expire l'Intégration
      if (e instanceof MetaAuthError && !tokenOverride) await this.integrations.markAsExpired(integration.id);
      throw e;
    }
  }

  /** Tous les éléments d'une liste Graph, en suivant la pagination de Meta (curseur `after`). */
  private async graphList(integration: Integration, path: string, query: Record<string, string> = {}) {
    const items: any[] = [];
    let after: string | undefined;
    do {
      const page = await this.graph(integration, path, after ? { ...query, after } : query);
      items.push(...(page.data ?? []));
      after = page.paging?.next ? page.paging.cursors?.after : undefined;
    } while (after);
    return items;
  }

  /** Le `fetch` nu vers la Graph API, sans logique de jeton. Avec `body` : un POST. */
  private async graphRaw(accessToken: string, path: string, query: Record<string, string> = {}, body?: URLSearchParams | FormData) {
    const params = new URLSearchParams({ ...query, access_token: accessToken });
    const res = await fetch(`${GRAPH_URL}${path}?${params}`, body ? { method: "POST", body } : undefined);
    if (res.ok) return res.json();

    // Meta signale un jeton expiré ou révoqué par le code 190 (souvent en HTTP 400), parfois par un 401
    const text = await res.text();
    const code = parseMetaErrorCode(text);
    if (res.status === 401 || res.status === 403 || code === 190 || code === 102) {
      throw new MetaAuthError(`Jeton Meta expiré ou révoqué (${res.status}) : ${text}`);
    }
    throw new MetaRequestError(res.status, code, `Erreur Meta (${res.status}) : ${text}`);
  }

  private async validAccessToken(integration: Integration) {
    const expiresSoon = integration.expires_at && integration.expires_at.getTime() - Date.now() < REFRESH_MARGIN_MS;
    if (expiresSoon) return this.refresh(integration);
    return this.integrations.decrypt(integration.access_token);
  }
}

class MetaAuthError extends Error {}

/** Meta a répondu par une erreur autre qu'un jeton invalide. */
class MetaRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
  }
}

function parseMetaErrorCode(body: string): number | undefined {
  try {
    const code = JSON.parse(body)?.error?.code;
    return typeof code === "number" ? code : undefined;
  } catch {
    return undefined;
  }
}

// codes Meta d'erreur temporaire ou de limite de débit : réessayer plus tard suffit
const META_TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);

/**
 * La raison d'un échec d'appel à Meta, en `type` stable pour le Plugin WP :
 * integration-expired, permission-missing, content-rejected ou network-unavailable.
 * Renvoie undefined pour une erreur qui ne vient pas de Meta (bogue, base de données…).
 */
export function metaFailureType(error: unknown) {
  if (error instanceof MetaAuthError) return "integration-expired";
  if (error instanceof MetaRequestError) {
    if (error.code === 10 || (error.code !== undefined && error.code >= 200 && error.code < 300)) return "permission-missing";
    if (error.status >= 500 || (error.code !== undefined && META_TRANSIENT_CODES.has(error.code))) return "network-unavailable";
    return "content-rejected";
  }
  if (error instanceof TypeError && error.message === "fetch failed") return "network-unavailable"; // Meta injoignable
  return undefined;
}

/** Meta donne les dates en « 2026-10-20T09:00:00+0000 » : on normalise en ISO 8601. */
function metaDate(value: unknown) {
  if (typeof value !== "string") return null;
  const date = new Date(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}
