import { DatabaseService } from "../../src/core/database/database.service";

/** Les Fonctionnalités, créées si besoin (slug = label pour les tests). */
export async function givenFeatures(db: DatabaseService, slugs: string[]) {
  return Promise.all(slugs.map((slug) => db.feature.upsert({ where: { slug }, update: {}, create: { slug, label: slug } })));
}

/** Un Site d'un Client, dont le plafond autorise les Fonctionnalités données. */
export async function givenSite(db: DatabaseService, clientId: number, domain: string, features: string[] = []) {
  const site = await db.site.create({ data: { domain, client_id: clientId } });
  for (const feature of await givenFeatures(db, features)) {
    await db.siteFeature.create({ data: { site_id: site.id, feature_id: feature.id } });
  }
  return site;
}

/** Une surcharge individuelle ; `siteId` null = sur tous les Sites de l'utilisateur. */
export async function givenOverride(
  db: DatabaseService,
  userId: number,
  slug: string,
  effect: "ADD" | "REMOVE",
  siteId: number | null = null,
) {
  const [feature] = await givenFeatures(db, [slug]);
  return db.userFeature.create({ data: { user_id: userId, feature_id: feature.id, site_id: siteId, effect } });
}

/**
 * Donne à l'utilisateur une Fonctionnalité sur un Site de son propre Client, créé pour l'occasion :
 * de quoi passer les contrôles de droits dans les tests qui ne portent pas sur eux.
 */
export async function givenFeatureOnOwnSite(db: DatabaseService, userId: number, slug: string) {
  const client = await db.client.create({ data: { name: `Client de ${userId}`, users: { create: { user_id: userId } } } });
  const site = await givenSite(db, client.id, `site-${client.id}.fr`, [slug]);
  await givenOverride(db, userId, slug, "ADD", site.id);
  return site;
}

/** Un pack contenant les Fonctionnalités, attribué à l'utilisateur ; `siteId` null = sur tous ses Sites. */
export async function givenPack(db: DatabaseService, userId: number, features: string[], siteId: number | null = null) {
  const pack = await db.pack.create({ data: { slug: `pack-${Date.now()}-${Math.random()}`, label: "Pack de test" } });
  for (const feature of await givenFeatures(db, features)) {
    await db.packFeature.create({ data: { pack_id: pack.id, feature_id: feature.id } });
  }
  return db.userPack.create({ data: { user_id: userId, pack_id: pack.id, site_id: siteId } });
}
