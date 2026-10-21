import { HttpStatus, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Integration, IntegrationStatus, Prisma, Resource, ResourceType } from "../../generated/prisma/client";
import { decrypt, encrypt, encryptionKey } from "../crypto/encryption";
import { DatabaseService } from "../database/database.service";
import { ProblemException } from "../problems/problem.exception";

/** Une ressource telle que MetaService la renvoie, avant écriture en base. */
export interface ResourceInput {
  type: ResourceType;
  externalId: string;
  name: string;
  accessToken?: string; // jeton propre (pages Facebook)
  parentExternalId?: string; // compte Instagram → external_id de sa page
  metadata?: Record<string, unknown>;
}

/** Pour savoir si une Ressource est accessible, et qui la gère : chaque Intégration qui y mène. */
const RESOURCE_ACCESS = {
  integrations: { select: { integration: { select: { status: true, client_id: true } } } },
} satisfies Prisma.ResourceInclude;

/** Une Intégration et les Ressources auxquelles elle mène. */
const WITH_RESOURCES = {
  resources: { include: { resource: { include: RESOURCE_ACCESS } }, orderBy: { resource_id: "asc" } },
} satisfies Prisma.IntegrationInclude;

type ResourceWithAccess = Resource & { integrations: { integration: { status: IntegrationStatus } }[] };

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
   * Après le callback OAuth. Une reconnexion de la même personne Meta met à jour
   * la ligne existante (unique sur provider + external_user_id).
   */
  upsertFromOAuth(input: {
    externalUserId: string;
    accessToken: string;
    expiresAt: Date;
    scopes: string[];
    clientId: number | null;
    createdById: number;
  }) {
    const tokens = { access_token: this.encrypt(input.accessToken), expires_at: input.expiresAt };
    return this.db.integration.upsert({
      where: { provider_external_user_id: { provider: "META", external_user_id: input.externalUserId } },
      update: { ...tokens, scopes: input.scopes, status: "ACTIVE" },
      create: {
        ...tokens,
        provider: "META",
        external_user_id: input.externalUserId,
        scopes: input.scopes,
        client_id: input.clientId,
        created_by_id: input.createdById,
      },
    });
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
   * ne référence (pas de Site). Les autres restent, inaccessibles tant qu'on ne les reconnecte pas.
   */
  private deleteOrphans(tx: Prisma.TransactionClient, resourceIds: number[]) {
    return tx.resource.deleteMany({ where: { id: { in: resourceIds }, site_id: null, integrations: { none: {} } } });
  }

  async findResourceById(id: number) {
    const resource = await this.db.resource.findUnique({ where: { id }, include: RESOURCE_ACCESS });
    if (!resource) throw new ProblemException(HttpStatus.NOT_FOUND, "resource-not-found", "Ressource introuvable", `Ressource ${id} introuvable`);
    return resource;
  }

  /** Rattache (ou détache avec null) une page / un compte à un site. La Ressource doit exister (findResourceById). */
  attachResourceToSite(id: number, siteId: number | null) {
    return this.db.resource.update({ where: { id }, data: { site_id: siteId }, include: RESOURCE_ACCESS });
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
  toPublic(integration: Integration & { resources: { resource: ResourceWithAccess }[] }) {
    const { access_token, resources, ...rest } = integration;
    return { ...rest, resources: resources.map((l) => this.toPublicResource(l.resource)) };
  }

  /** Une Ressource est accessible si au moins une Intégration ACTIVE y mène. */
  toPublicResource({ integrations, ...resource }: ResourceWithAccess) {
    return { ...resource, accessible: integrations.some((l) => l.integration.status === "ACTIVE") };
  }

  // --- Chiffrement AES-256-GCM (voir core/crypto) --------------------------

  encrypt(plain: string) {
    return encrypt(this.encryptionKey, plain);
  }

  decrypt(stored: string) {
    return decrypt(this.encryptionKey, stored);
  }
}
