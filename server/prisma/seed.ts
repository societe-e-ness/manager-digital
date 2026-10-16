// Données de départ pour le développement : un utilisateur agence, un client,
// un site, et les fonctionnalités (dont social.*, voir core/rights).
// Relançable sans doublons : tout passe par des upsert sur les champs uniques.
//
//   npx prisma db seed     (déclaré dans prisma.config.ts)

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const AGENCY_USER = { email: "i.clement@eness.fr", name: "Ismaël Clément" };
const CLIENT_NAME = "Client test";
const SITE_DOMAIN = "site-test.fr";

// slug au format domaine.action
const FEATURES = [
  { slug: "ads.read", label: "Lire les campagnes publicitaires" },
  { slug: "ai_summary.read", label: "Lire les synthèses IA" },
  { slug: "comments.update", label: "Répondre aux commentaires" },
  { slug: "social.read", label: "Lister les publications des réseaux sociaux" },
  { slug: "social.publish", label: "Diffuser une actualité sur les réseaux sociaux" },
  { slug: "social.manage", label: "Gérer les comptes et pages des réseaux sociaux" },
];

async function main() {
  // --- Utilisateur agence (sso_subject sera rempli à la première connexion SSO)
  const user = await prisma.user.upsert({
    where: { email: AGENCY_USER.email },
    update: { name: AGENCY_USER.name, type: "AGENCY" },
    create: { ...AGENCY_USER, type: "AGENCY" },
  });

  // --- Client (pas de champ unique : on le retrouve par son nom)
  const client =
    (await prisma.client.findFirst({ where: { name: CLIENT_NAME } })) ??
    (await prisma.client.create({ data: { name: CLIENT_NAME } }));

  // --- Site
  const site = await prisma.site.upsert({
    where: { domain: SITE_DOMAIN },
    update: { client_id: client.id },
    create: { domain: SITE_DOMAIN, client_id: client.id },
  });

  // --- Rattachement utilisateur ↔ client
  await prisma.userClient.upsert({
    where: { user_id_client_id: { user_id: user.id, client_id: client.id } },
    update: {},
    create: { user_id: user.id, client_id: client.id },
  });

  // --- Fonctionnalités
  for (const { slug, label } of FEATURES) {
    const feature = await prisma.feature.upsert({
      where: { slug },
      update: { label },
      create: { slug, label },
    });

    // Disponible sur le site de test (site_feature est le plafond des droits)
    await prisma.siteFeature.upsert({
      where: { site_id_feature_id: { site_id: site.id, feature_id: feature.id } },
      update: {},
      create: { site_id: site.id, feature_id: feature.id },
    });

    // Accordée à l'utilisateur agence sur tous les sites (site_id null).
    // Pas d'upsert possible : l'unicité "tous sites" est portée par un index partiel que Prisma ne connaît pas.
    const existing = await prisma.userFeature.findFirst({
      where: { user_id: user.id, feature_id: feature.id, site_id: null },
    });
    if (!existing) {
      await prisma.userFeature.create({
        data: { user_id: user.id, feature_id: feature.id, site_id: null, effect: "ADD" },
      });
    }
  }

  console.log(`Seed OK : ${user.email} / ${client.name} / ${site.domain} / ${FEATURES.length} features`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
