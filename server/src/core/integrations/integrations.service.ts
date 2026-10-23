import { HttpStatus, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, type Integration, type IntegrationStatus, type Resource, type ResourceType } from "../../generated/prisma/client";
import { decrypt, encrypt, encryptionKey } from "../crypto/encryption";
import { DatabaseService } from "../database/database.service";
import { ProblemException } from "../problems/problem.exception";
import type { VisibleClients } from "../rights/rights.service";

/** Une ressource telle que MetaService la renvoie, avant écriture en base. */
export interface ResourceInput {
  type: ResourceType;
  externalId: string;
  name: string;
  accessToken?: string; // jeton propre (pages Facebook)
  parentExternalId?: string; // compte Instagram → external_id de sa page
  metadata?: Record<string, unknown>;
}

/**
 * Pour savoir si une Ressource est accessible, qui la gère (chaque Intégration qui y mène)
 * et à quel Client appartient son Site.
 */
const RESOURCE_ACCESS = {
  integrations: { select: { integration: { select: { status: true, client_id: true } } } },
  site: { select: { client_id: true } },
} satisfies Prisma.ResourceInclude;

/** Une Intégration et les Ressources auxquelles elle mène. */
const WITH_RESOURCES = {
  resources: { include: { resource: { include: RESOURCE_ACCESS } }, orderBy: { resource_id: "asc" } },
  created_by: { select: { id: true, email: true, name: true } }, // qui a connecté le compte
} satisfies Prisma.IntegrationInclude;

type ResourceWithAccess = Resource & {
  integrations: { integration: { status: IntegrationStatus } }[];
  site: { client_id: number } | null;
};

/** Un lien vers la Ressource par une Intégration ACTIVE du Client (ou de l'agence) : jamais l'accès d'un autre Client. */
function activeLinkOf(resourceId: number, clientId: number) {
  return {
    resource_id: resourceId,
    integration: { status: "ACTIVE", OR: [{ client_id: clientId }, { client_id: null }] },
  } satisfies Prisma.IntegrationResourceWhereInput;
}

/** 409 : la Ressource est (ou vient d'être) rattachée à un autre Site. */
export function resourceAlreadyAttached() {
  return new ProblemException(
    HttpStatus.CONFLICT,
    "resource-already-attached",
    "Ressource déjà rattachée",
    "Cette Ressource est rattachée à un autre Site : la détacher d'abord",
  );
}

/**
 * Tout ce qui touche aux tables `integration` (la clé : une personne Meta qui a donné
 * son accord), `resource` (les portes : pages, comptes Instagram, comptes publicitaires,
 * uniques quel que soit le nombre d'Intégrations qui y mènent) et `integration_resource`
 * (le lien entre les deux, avec le jeton de page), plus le chiffrement des jetons.
 *
 * Ce service ne parle jamais à Meta. C'est le rôle de MetaService.
 */
@Injectable()
export class IntegrationsService {
  // 32 octets, lus depuis ENCRYPTION_KEY (base64)
  private readonly encryptionKey: Buffer;

  constructor(
    private readonly db: DatabaseService,
    config: ConfigService,
  ) {
    this.encryptionKey = encryptionKey(config.getOrThrow<string>("ENCRYPTION_KEY"));
  }

  // --- Intégrations -------------------------------------------------------

  async findById(id: number) {
    const integration = await this.db.integration.findUnique({ where: { id }, include: WITH_RESOURCES });
    if (!integration) throw new ProblemException(HttpStatus.NOT_FOUND, "integration-not-found", "Intégration introuvable", `Intégration ${id} introuvable`);
    return integration;
  }

  /** Toutes les intégrations, ou celles d'un client. `client_id` null = accès de l'agence. */
  list(clientId?: number) {
    return this.db.integration.findMany({
      where: clientId === undefined ? {} : { client_id: clientId },
      include: WITH_RESOURCES,
      orderBy: { created_at: "asc" },
    });
  }

  /**
   * Après le callback OAuth. Une reconnexion de la même personne Meta pour le même Client
   * met à jour la ligne existante ; pour un autre Client, elle en crée une autre.
   * Pas d'upsert Prisma : l'unicité de l'accès de l'agence (client_id null) est un index partiel.
   */
  async upsertFromOAuth(
    input: {
      externalUserId: string;
      accessToken: string;
      expiresAt: Date;
      scopes: string[];
      clientId: number | null;
      createdById: number;
    },
    retried = false,
  ): Promise<Integration> {
    const tokens = { access_token: this.encrypt(input.accessToken), expires_at: input.expiresAt };
    const existing = await this.db.integration.findFirst({
      where: { provider: "META", external_user_id: input.externalUserId, client_id: input.clientId },
    });
    if (existing) {
      // la personne qui reconnecte devient celle qui peut déconnecter
      return this.db.integration.update({
        where: { id: existing.id },
        data: { ...tokens, scopes: input.scopes, status: "ACTIVE", created_by_id: input.createdById },
      });
    }
    try {
      return await this.db.integration.create({
        data: {
          ...tokens,
          provider: "META",
          external_user_id: input.externalUserId,
          scopes: input.scopes,
          client_id: input.clientId,
          created_by_id: input.createdById,
        },
      });
    } catch (e) {
      // Deux retours simultanés de Meta (double-clic) : l'autre vient de la créer, on la met à jour.
      const duplicate = e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
      if (duplicate && !retried) return this.upsertFromOAuth(input, true);
      throw e;
    }
  }

  saveToken(id: number, accessToken: string, expiresAt: Date) {
    return this.db.integration.update({
      where: { id },
      data: { access_token: this.encrypt(accessToken), expires_at: expiresAt, status: "ACTIVE" },
    });
  }

  markAsExpired(id: number) {
    return this.db.integration.update({ where: { id }, data: { status: "EXPIRED" } });
  }

  /** Supprime l'Intégration et ses liens, puis les Ressources auxquelles plus rien ne mène. */
  async disconnect(id: number) {
    const integration = await this.findById(id);
    await this.db.$transaction(async (tx) => {
      await tx.integration.delete({ where: { id } }); // les liens suivent (cascade)
      await this.deleteOrphans(tx, integration.resources.map((l) => l.resource_id));
    });
  }

  // --- Ressources ---------------------------------------------------------

  /**
   * Enregistre ce que Meta a renvoyé au travers d'une Intégration. Une Ressource déjà connue,
   * même par une autre Intégration, est mise à jour ; une nouvelle est créée. Les pages sont
   * traitées avant les comptes Instagram pour pouvoir renseigner parent_id. Les liens vers
   * ce que l'Intégration n'atteint plus sont retirés.
   */
  async syncResources(integrationId: number, resources: ResourceInput[]) {
    const { provider } = await this.db.integration.findUniqueOrThrow({ where: { id: integrationId }, select: { provider: true } });
    const idsByExternalId = new Map<string, number>();
    const ordered = [...resources].sort((a, b) => (a.parentExternalId ? 1 : 0) - (b.parentExternalId ? 1 : 0));

    for (const r of ordered) {
      const data = {
        name: r.name,
        parent_id: r.parentExternalId ? (idsByExternalId.get(r.parentExternalId) ?? null) : null,
        metadata: (r.metadata ?? {}) as Prisma.InputJsonValue,
        last_synced_at: new Date(),
        last_error: null,
      };
      const resource = await this.db.resource.upsert({
        where: { provider_type_external_id: { provider, type: r.type, external_id: r.externalId } },
        update: data,
        create: { ...data, provider, type: r.type, external_id: r.externalId },
      });

      const link = { access_token: r.accessToken ? this.encrypt(r.accessToken) : null };
      await this.db.integrationResource.upsert({
        where: { integration_id_resource_id: { integration_id: integrationId, resource_id: resource.id } },
        update: link,
        create: { ...link, integration_id: integrationId, resource_id: resource.id },
      });
      idsByExternalId.set(r.externalId, resource.id);
    }

    const stale = await this.db.integrationResource.findMany({
      where: { integration_id: integrationId, resource_id: { notIn: [...idsByExternalId.values()] } },
      select: { resource_id: true },
    });
    if (stale.length === 0) return;
    const staleIds = stale.map((l) => l.resource_id);
    await this.db.$transaction(async (tx) => {
      await tx.integrationResource.deleteMany({ where: { integration_id: integrationId, resource_id: { in: staleIds } } });
      await this.deleteOrphans(tx, staleIds);
    });
  }

  /**
   * Parmi ces Ressources, supprime celles auxquelles plus aucune Intégration ne mène et que rien
   * ne référence (ni Site, ni Publication diffusée). Les autres restent, inaccessibles tant qu'on
   * ne les reconnecte pas.
   */
  private deleteOrphans(tx: Prisma.TransactionClient, resourceIds: number[]) {
    return tx.resource.deleteMany({
      where: { id: { in: resourceIds }, site_id: null, integrations: { none: {} }, publications: { none: {} } },
    });
  }

  /**
   * Un accès actif à la Ressource pour un Client : une Intégration ACTIVE de ce Client (ou de l'agence)
   * qui y mène, et le jeton de page obtenu par elle. Jamais l'accès Meta d'un autre Client.
   */
  async activeAccess(resourceId: number, clientId: number) {
    const link = await this.db.integrationResource.findFirst({
      where: { ...activeLinkOf(resourceId, clientId), access_token: { not: null } },
      include: { integration: true },
      orderBy: { integration_id: "asc" },
    });
    return link ? { integration: link.integration, pageToken: this.decrypt(link.access_token!) } : null;
  }

  /** Une Intégration ACTIVE de ce Client (ou de l'agence) qui mène à la Ressource (comptes Instagram : jeton de la personne). */
  async activeIntegration(resourceId: number, clientId: number) {
    const link = await this.db.integrationResource.findFirst({
      where: activeLinkOf(resourceId, clientId),
      include: { integration: true },
      orderBy: { integration_id: "asc" },
    });
    return link?.integration ?? null;
  }

  async findResourceById(id: number) {
    const resource = await this.db.resource.findUnique({ where: { id }, include: RESOURCE_ACCESS });
    if (!resource) throw new ProblemException(HttpStatus.NOT_FOUND, "resource-not-found", "Ressource introuvable", `Ressource ${id} introuvable`);
    return resource;
  }

  /**
   * Les Ressources d'un Client : celles rattachées à ses Sites, quelle que soit la personne qui les a
   * connectées, et celles qu'aucun Site n'a encore, atteintes par ses Intégrations. Sans Client : toutes.
   */
  listResources(clientId?: number) {
    return this.db.resource.findMany({
      where:
        clientId === undefined
          ? {}
          : {
              OR: [
                { site: { client_id: clientId } },
                { site_id: null, integrations: { some: { integration: { client_id: clientId } } } },
              ],
            },
      include: RESOURCE_ACCESS,
      orderBy: { id: "asc" },
    });
  }

  /** Les Ressources rattachées à un Site (routes du Plugin WP). */
  listSiteResources(siteId: number) {
    return this.db.resource.findMany({ where: { site_id: siteId }, include: RESOURCE_ACCESS, orderBy: { id: "asc" } });
  }

  /**
   * Rattache (ou détache avec null) une Ressource à un Site, si elle est toujours rattachée à
   * `expectedSiteId` (ce que l'appelant a contrôlé). Sinon, quelqu'un est passé entre-temps : 409.
   */
  async attachResourceToSite(id: number, siteId: number | null, expectedSiteId: number | null) {
    const { count } = await this.db.resource.updateMany({ where: { id, site_id: expectedSiteId }, data: { site_id: siteId } });
    if (count === 0) throw resourceAlreadyAttached();
    return this.findResourceById(id);
  }

  /** Le Client d'un Site existant. */
  async siteClientId(siteId: number) {
    return (await this.db.site.findUniqueOrThrow({ where: { id: siteId }, select: { client_id: true } })).client_id;
  }

  /** Les ressources d'un site prêtes à être synchronisées, avec leurs liens vers des Intégrations ACTIVE. */
  findActiveResources(siteId: number) {
    const active = { integration: { status: "ACTIVE" } } satisfies Prisma.IntegrationResourceWhereInput;
    return this.db.resource.findMany({
      where: { site_id: siteId, integrations: { some: active } },
      include: { integrations: { where: active, include: { integration: true } } },
    });
  }

  // --- Présentation -------------------------------------------------------

  /** Ce qu'on renvoie à l'API : jamais de jeton, ni sur l'intégration ni sur ses liens. */
  toPublic(integration: Integration & { resources: { resource: ResourceWithAccess }[] }, visible: VisibleClients) {
    const { access_token, resources, ...rest } = integration;
    return { ...rest, resources: resources.map((l) => this.toPublicResource(l.resource, visible)) };
  }

  /**
   * Une Ressource est accessible si au moins une Intégration ACTIVE y mène. Rattachée au Site
   * d'un Client que l'utilisateur ne voit pas, elle apparaît sans Site et `attached_elsewhere`.
   */
  toPublicResource({ integrations, site, ...resource }: ResourceWithAccess, visible: VisibleClients) {
    const elsewhere = site !== null && visible !== "all" && !visible.includes(site.client_id);
    return {
      ...resource,
      site_id: elsewhere ? null : resource.site_id,
      attached_elsewhere: elsewhere,
      accessible: integrations.some((l) => l.integration.status === "ACTIVE"),
    };
  }

  // --- Chiffrement AES-256-GCM (voir core/crypto) --------------------------

  encrypt(plain: string) {
    return encrypt(this.encryptionKey, plain);
  }

  decrypt(stored: string) {
    return decrypt(this.encryptionKey, stored);
  }
}
