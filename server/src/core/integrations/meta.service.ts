import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac } from "node:crypto";
import type { Integration } from "../../generated/prisma/client";
import { IntegrationsService, type ResourceInput } from "./integrations.service";

const GRAPH_URL = "https://graph.facebook.com/v21.0";
const STATE_TTL_MS = 10 * 60 * 1000;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Le seul fichier du projet qui parle à Meta.
 *
 *  1. OAuth : URL de consentement, échange du code, identité, rafraîchissement du jeton
 *  2. State signé : empêche de rattacher un compte Meta au mauvais client
 *  3. Graph API : inventaire des ressources, métriques de campagnes
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
      scope: "ads_read,business_management,pages_show_list,pages_read_engagement",
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
   * Pour une page, passer son jeton propre déchiffré en `tokenOverride`.
   */
  private async graph(integration: Integration, path: string, query: Record<string, string> = {}, tokenOverride?: string) {
    const token = tokenOverride ?? (await this.validAccessToken(integration));
    try {
      return await this.graphRaw(token, path, query);
    } catch (e) {
      if (e instanceof MetaAuthError) await this.integrations.markAsExpired(integration.id);
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

  /** Le `fetch` nu vers la Graph API, sans logique de jeton. */
  private async graphRaw(accessToken: string, path: string, query: Record<string, string> = {}) {
    const params = new URLSearchParams({ ...query, access_token: accessToken });
    const res = await fetch(`${GRAPH_URL}${path}?${params}`);

    if (res.status === 401 || res.status === 403) {
      throw new MetaAuthError(`Jeton Meta expiré ou révoqué (${res.status}) : ${await res.text()}`);
    }
    if (!res.ok) throw new Error(`Erreur Meta (${res.status}) : ${await res.text()}`);
    return res.json();
  }

  private async validAccessToken(integration: Integration) {
    const expiresSoon = integration.expires_at && integration.expires_at.getTime() - Date.now() < REFRESH_MARGIN_MS;
    if (expiresSoon) return this.refresh(integration);
    return this.integrations.decrypt(integration.access_token);
  }
}

class MetaAuthError extends Error {}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}
