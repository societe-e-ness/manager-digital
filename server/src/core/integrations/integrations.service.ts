import { Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Prisma, ResourceType } from "../../generated/prisma/client";
import { DatabaseService } from "../database/database.service";

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
 * Tout ce qui touche aux tables `integration` (la clé : une personne Meta qui a donné
 * son accord) et `integration_resource` (les portes : ses pages, comptes Instagram,
 * comptes publicitaires), plus le chiffrement des jetons.
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
    this.encryptionKey = Buffer.from(config.getOrThrow<string>("ENCRYPTION_KEY"), "base64");
  }

  // --- Intégrations -------------------------------------------------------

  async findById(id: number) {
    const integration = await this.db.integration.findUnique({ where: { id }, include: { resources: true } });
    if (!integration) throw new NotFoundException(`Intégration ${id} introuvable`);
    return integration;
  }

  /** Toutes les intégrations, ou celles d'un client. `client_id` null = accès de l'agence. */
  list(clientId?: number) {
    return this.db.integration.findMany({
      where: clientId === undefined ? {} : { client_id: clientId },
      include: { resources: true },
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

  async disconnect(id: number) {
    await this.findById(id);
    await this.db.integration.delete({ where: { id } }); // les ressources suivent (cascade)
  }

  // --- Ressources ---------------------------------------------------------

  /**
   * Enregistre ce que Meta a renvoyé. Une ressource déjà connue est mise à jour,
   * une nouvelle est créée. Les pages sont traitées avant les comptes Instagram
   * pour pouvoir renseigner parent_id.
   */
  async syncResources(integrationId: number, resources: ResourceInput[]) {
    const idsByExternalId = new Map<string, number>();
    const ordered = [...resources].sort((a, b) => (a.parentExternalId ? 1 : 0) - (b.parentExternalId ? 1 : 0));

    for (const r of ordered) {
      const data = {
        name: r.name,
        access_token: r.accessToken ? this.encrypt(r.accessToken) : null,
        parent_id: r.parentExternalId ? (idsByExternalId.get(r.parentExternalId) ?? null) : null,
        metadata: (r.metadata ?? {}) as Prisma.InputJsonValue,
        last_synced_at: new Date(),
        last_error: null,
      };
      const saved = await this.db.integrationResource.upsert({
        where: { integration_id_type_external_id: { integration_id: integrationId, type: r.type, external_id: r.externalId } },
        update: data,
        create: { ...data, integration_id: integrationId, type: r.type, external_id: r.externalId },
      });
      idsByExternalId.set(r.externalId, saved.id);
    }
  }

  async findResourceById(id: number) {
    const resource = await this.db.integrationResource.findUnique({ where: { id }, include: { integration: true } });
    if (!resource) throw new NotFoundException(`Ressource ${id} introuvable`);
    return resource;
  }

  /** Rattache (ou détache avec null) une page / un compte à un site. */
  async attachResourceToSite(id: number, siteId: number | null) {
    await this.findResourceById(id);
    return this.db.integrationResource.update({ where: { id }, data: { site_id: siteId } });
  }

  /** Les ressources d'un site prêtes à être synchronisées : intégration ACTIVE. */
  findActiveResources(siteId: number) {
    return this.db.integrationResource.findMany({
      where: { site_id: siteId, integration: { status: "ACTIVE" } },
      include: { integration: true },
    });
  }

  // --- Présentation -------------------------------------------------------

  /** Ce qu'on renvoie à l'API : jamais de jeton, ni sur l'intégration ni sur ses ressources. */
  toPublic(integration: { access_token: string; resources?: { access_token: string | null }[] } & Record<string, unknown>) {
    const { access_token, resources, ...rest } = integration;
    return {
      ...rest,
      resources: resources?.map(({ access_token, ...r }) => r),
    };
  }

  // --- Chiffrement AES-256-GCM --------------------------------------------
  // Valeur stockée (base64) : [ IV 12 octets | tag 16 octets | données chiffrées ]
  //  - l'IV est aléatoire : deux chiffrements du même texte donnent deux résultats
  //  - le tag garantit que la valeur n'a pas été modifiée en base

  encrypt(plain: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
  }

  decrypt(stored: string) {
    const buffer = Buffer.from(stored, "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, buffer.subarray(0, 12));
    decipher.setAuthTag(buffer.subarray(12, 28));
    // Lève une erreur si la clé est mauvaise ou si la valeur a été altérée.
    return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString("utf8");
  }
}
