# Spec : connexion aux réseaux sociaux pour le Plugin WP (Meta)

Vocabulaire : [GLOSSARY.md](../../GLOSSARY.md). Cadrage : [docs/cadrage/integrations-rs.md](../cadrage/integrations-rs.md). Décisions structurantes : [ADR 0001](../adr/0001-sso-pour-tous-lien-magique-en-secours.md), [ADR 0002](../adr/0002-oauth-pour-le-plugin-wp.md).

## Problem Statement

L'agence et ses Clients rédigent des Actualités dans le Plugin WP, installé sur leurs Sites. Ils veulent les diffuser sur leurs réseaux sociaux (page Facebook, compte Instagram) sans quitter WordPress, et sans recopier le contenu à la main sur chaque réseau.

Aujourd'hui, le Manager Digital sait connecter un compte Meta et inventorier ses Ressources, mais :

- il ne demande que des permissions de lecture publicitaire ;
- il ne sait ni lire le contenu des Publications, ni publier ;
- le Plugin WP n'a aucun moyen de s'adresser à lui au nom d'une personne et d'un Site ;
- une même page connectée par deux personnes apparaît en double ;
- la déconnexion d'une Intégration efface tout ce qui y est lié.

## Solution

Le Manager Digital expose au Plugin WP une API qui, pour le Site où le Plugin WP est installé et pour la personne connectée :

- liste les Ressources du Site ;
- liste les Publications existantes de ces Ressources (flux entrant, facultatif en V1) ;
- diffuse une Actualité vers les Ressources choisies, en une Publication par Ressource (flux sortant) ;
- prévient avant la Diffusion quand un réseau va refuser une Publication, et bloque l'action ;
- garde l'historique de chaque Publication diffusée, avec son statut, et permet de relancer celles qui ont échoué.

Le Plugin WP se connecte au Manager Digital par OAuth 2.0. La personne s'identifie par le SSO de l'agence, ou par lien magique en secours, puis autorise le Site.

Côté Manager Digital, un utilisateur qui en a le droit connecte un compte Meta, puis rattache les Ressources obtenues à un Site. Un Utilisateur client peut le faire seul, sans attendre l'agence.

## User Stories

### Connexion du Plugin WP au Manager Digital

1. En tant qu'Utilisateur agence, je veux connecter le Plugin WP d'un Site au Manager Digital en me connectant avec le SSO de l'agence, pour agir sur ce Site sans gérer un mot de passe de plus.
2. En tant qu'Utilisateur client, je veux connecter le Plugin WP de mon Site avec le SSO de l'agence, pour utiliser le même compte partout.
3. En tant qu'utilisateur, je veux pouvoir me connecter par lien magique quand le SSO est en panne ou en maintenance, pour ne pas être bloqué.
4. En tant qu'utilisateur, je veux autoriser explicitement un Site lors de la connexion du Plugin WP, pour savoir à quel Site je donne accès.
5. En tant qu'utilisateur, je veux qu'on refuse de me laisser autoriser un Site qui n'appartient pas à un de mes Clients, pour ne pas agir chez quelqu'un d'autre.
6. En tant qu'Utilisateur agence, je veux pouvoir autoriser n'importe quel Site, pour intervenir chez tous les Clients.
7. En tant qu'utilisateur, je veux que le Plugin WP reste connecté sans que je doive me reconnecter à chaque visite, pour travailler sans friction.
8. En tant qu'utilisateur, je veux pouvoir déconnecter le Plugin WP d'un Site, pour couper l'accès si je n'en ai plus besoin.
9. En tant qu'Utilisateur agence, je veux pouvoir révoquer l'accès d'un Plugin WP, par exemple quand un prestataire WordPress quitte le projet, pour que plus rien ne puisse être publié depuis ce Site sans nouvelle autorisation.
10. En tant qu'agence, je veux qu'aucun secret stocké dans la base WordPress ne suffise à publier sur les réseaux d'un Client, pour limiter les conséquences d'un WordPress compromis.

### Connexion à Meta et Ressources

11. En tant qu'Utilisateur agence, je veux connecter mon compte Meta pour qu'il remonte les pages et comptes Instagram auxquels j'ai accès via Business Manager, pour gérer les réseaux de plusieurs Clients d'un coup.
12. En tant qu'Utilisateur client, je veux connecter mon propre compte Meta, pour être autonome.
13. En tant qu'utilisateur, je veux donner toutes les permissions nécessaires en une seule fois, pour ne pas devoir me reconnecter quand une nouvelle fonctionnalité arrive.
14. En tant qu'utilisateur, je veux voir quelles permissions ont réellement été accordées, pour comprendre pourquoi une action est impossible si j'en ai décoché une.
15. En tant qu'utilisateur ayant le droit de gérer les réseaux sociaux, je veux rattacher une page Facebook ou un compte Instagram à un Site, pour qu'il soit utilisable depuis le Plugin WP de ce Site.
16. En tant qu'utilisateur ayant ce même droit, je veux détacher une Ressource d'un Site, pour qu'elle n'y soit plus proposée.
17. En tant qu'Utilisateur client, je veux ne pouvoir rattacher des Ressources qu'aux Sites de mes propres Clients, pour ne pas toucher aux Sites des autres.
18. En tant qu'utilisateur, je veux qu'une Ressource ne puisse être rattachée qu'à un seul Site, pour éviter les ambiguïtés.
19. En tant qu'utilisateur, je veux qu'une page connectée à la fois par l'agence et par moi n'apparaisse qu'une seule fois, pour ne pas choisir entre deux copies identiques.
20. En tant qu'utilisateur, je veux que la Diffusion vers une page fonctionne tant qu'au moins une Intégration y donnant accès est active, pour ne pas être bloqué quand le jeton d'une autre personne expire.
21. En tant qu'Utilisateur client, je veux voir les Ressources rattachées aux Sites de mes Clients même si c'est l'agence qui les a connectées, pour ne pas devoir refaire la connexion moi-même.
22. En tant qu'utilisateur, je veux pouvoir déconnecter mes propres Intégrations, pour retirer l'accès que j'ai donné.
23. En tant qu'Utilisateur client, je veux ne pas pouvoir déconnecter l'Intégration de l'agence, pour ne pas casser un accès que je ne gère pas.
24. En tant qu'Utilisateur agence, je veux pouvoir déconnecter n'importe quelle Intégration, pour faire le ménage.
25. En tant qu'utilisateur, je veux que les jetons Meta soient renouvelés automatiquement avant leur expiration, pour ne pas avoir à me reconnecter tous les deux mois.
26. En tant qu'utilisateur, je veux qu'une Intégration dont le jeton a été révoqué soit signalée comme telle, pour savoir qu'il faut la reconnecter.

### Flux entrant : lister les Publications

27. En tant qu'utilisateur du Plugin WP ayant le droit de consultation, je veux voir les Publications récentes des Ressources de mon Site, pour savoir ce qui a déjà été posté.
28. En tant qu'utilisateur, je veux voir pour chaque Publication son texte, ses images, sa date, son réseau et un lien vers la Publication d'origine, pour la reconnaître sans quitter WordPress.
29. En tant qu'utilisateur, je veux que la liste soit à jour à quelques minutes près, pour voir mes dernières Publications.
30. En tant qu'utilisateur, je veux pouvoir parcourir la liste page par page, pour remonter dans l'historique.
31. En tant qu'utilisateur sans droit de consultation, je veux recevoir une erreur explicite, pour que le Plugin WP puisse m'expliquer pourquoi je ne vois rien.
32. En tant qu'utilisateur, je veux qu'une Ressource dont toutes les Intégrations ont expiré soit signalée par une erreur explicite, pour que le Plugin WP me le dise au lieu d'afficher une liste vide.

### Flux sortant : diffuser une Actualité

33. En tant qu'utilisateur du Plugin WP ayant le droit de publication, je veux choisir une ou plusieurs Ressources de mon Site comme cibles, pour diffuser là où je le souhaite.
34. En tant qu'utilisateur, je veux fournir pour chaque Ressource cible un texte adapté au réseau, pour respecter les usages de chacun.
35. En tant qu'utilisateur, je veux joindre une ou plusieurs images à la Diffusion, pour que mes Publications soient illustrées.
36. En tant qu'utilisateur, je veux joindre le lien de l'Actualité sur mon Site, pour amener du trafic vers le Site.
37. En tant qu'utilisateur, je veux que la Diffusion parte immédiatement, pour voir le résultat tout de suite.
38. En tant qu'utilisateur, je veux savoir avant de diffuser si un réseau va refuser ma Publication (par exemple Instagram sans image), et ne pas pouvoir lancer l'action dans ce cas, pour ne pas découvrir l'échec après coup.
39. En tant qu'utilisateur, je veux connaître le résultat de chaque Publication (réussie, ou échouée avec la raison), pour savoir où ma Diffusion est vraiment arrivée.
40. En tant qu'utilisateur, je veux que l'échec d'une Publication n'empêche pas les autres de partir, pour ne pas tout perdre à cause d'un seul réseau.
41. En tant qu'utilisateur, je veux relancer une Publication qui a échoué, pour réessayer après avoir reconnecté le compte.
42. En tant qu'utilisateur, je veux que mon Actualité reste publiée sur mon Site même si une Publication échoue, parce que le Site ne dépend pas des réseaux sociaux.
43. En tant qu'utilisateur, je veux retrouver l'historique des Publications d'une Actualité, avec leurs liens vers les réseaux, pour savoir où elle a été diffusée.
44. En tant qu'utilisateur, je veux que cet historique survive à la déconnexion de l'Intégration qui a servi, pour ne pas perdre la trace de mes Diffusions.
45. En tant qu'utilisateur sans droit de publication, je veux recevoir une erreur explicite si j'essaie de diffuser, pour que le Plugin WP puisse m'expliquer pourquoi.
46. En tant qu'utilisateur, je veux qu'on refuse une Diffusion vers une Ressource qui n'est pas rattachée à mon Site, pour ne pas publier ailleurs par erreur.
47. En tant qu'utilisateur, je veux que modifier ou supprimer mon Actualité sur le Site ne touche pas aux Publications déjà parties, pour que leur comportement reste prévisible.

### Droits

48. En tant qu'Utilisateur agence, je veux attribuer séparément la consultation, la publication et la gestion des réseaux sociaux, pour qu'un collaborateur puisse diffuser sans pouvoir modifier les branchements du Site.
49. En tant qu'agence, je veux que ces droits soient plafonnés par Site, pour vendre la fonctionnalité Site par Site.

### Développeur du Plugin WP

50. En tant que développeur du Plugin WP, je veux des erreurs dans un format standard, avec un code stable par cas (Intégration expirée, Ressource non rattachée, image requise…), pour afficher mes propres messages sans dépendre du texte de l'API.
51. En tant que développeur du Plugin WP, je veux un parcours OAuth standard (code d'autorisation + PKCE), pour utiliser une bibliothèque existante plutôt qu'un protocole maison.

## Implementation Decisions

### Modules

- **Intégrations** (existant, étendu). Il garde la connexion OAuth à Meta, le chiffrement des jetons, l'inventaire et le renouvellement des jetons. Il gagne le rattachement contrôlé par droits et la déduplication des Ressources, et ses permissions Meta sont étendues.
- **Client Meta** (existant, étendu). C'est le seul code qui parle à Meta. Il gagne la lecture des Publications d'une page et d'un compte Instagram, et la publication sur une page et sur un compte Instagram. Il traduit les réponses de Meta dans notre vocabulaire, comme il le fait déjà pour les métriques.
- **Authentification** (à construire, prérequis). Connexion par SSO auth.eness pour tous, lien magique en secours, sessions. Les tables existent déjà, pas le module.
- **Serveur d'autorisation du Plugin WP** (nouveau). Implémente OAuth 2.0 (code d'autorisation + PKCE) avec le Manager Digital comme serveur d'autorisation. La page d'autorisation réutilise l'Authentification, puis demande de choisir le Site. Délivre un jeton qui porte la personne et le Site, révocable.
- **Réseaux sociaux du Plugin WP** (nouveau). Les routes appelées par le Plugin WP : Ressources du Site, Publications, Diffusion, historique, relance. Il s'appuie sur le module Intégrations et sur le client Meta.
- **Droits** (existant en schéma). Trois nouvelles Fonctionnalités : `social.read`, `social.publish` et `social.manage`, soumises au plafond par Site.

### Changements de schéma

- **Utilisateurs.** Le type d'utilisateur ne détermine plus la méthode de connexion. Les commentaires qui associent SSO à l'agence et lien magique aux clients sont corrigés, et `sso_subject` peut être renseigné pour un Utilisateur client (ADR 0001).
- **Ressources.** Une Ressource est unique par réseau, type et identifiant externe, indépendamment de l'Intégration. Une table de liaison relie Ressources et Intégrations. Le jeton propre d'une page est rattaché à cette liaison, puisqu'il est obtenu au travers d'une Intégration précise.
- **Déconnexion.** Elle supprime l'Intégration et ses liaisons. Elle ne supprime une Ressource que si plus aucune Intégration n'y mène et que rien ne la référence. Sinon, la Ressource reste, marquée inaccessible.
- **Rattachement à un Site.** Il reste porté par la Ressource, avec au plus un Site.
- **Nouvelle table des Publications diffusées.** Elle porte l'Actualité d'origine (identifiée par le Site et l'identifiant de l'Actualité côté WordPress), la Ressource cible, le texte envoyé, le statut (en cours, réussie, échouée), la raison de l'échec, l'identifiant et le lien de la Publication côté réseau, l'auteur et les dates. Elle ne dépend pas de l'Intégration utilisée, pour survivre à sa déconnexion.
- **Tables OAuth du Plugin WP.** Elles portent les codes d'autorisation (courte durée, usage unique, défi PKCE) et les autorisations accordées (personne, Site, jeton haché, date de révocation). Les jetons sont stockés hachés, comme les liens magiques et les sessions.
- **Données de départ.** Les trois Fonctionnalités `social.*` sont ajoutées au seed.

### Contrats d'API

- **Routes du Plugin WP.** Elles sont authentifiées par le jeton OAuth du Plugin WP. Le Site vient du jeton, jamais d'un paramètre :
  - lister les Ressources du Site, avec leur état (accessible ou à reconnecter) ;
  - lister les Publications des Ressources du Site, paginées ;
  - vérifier une Diffusion sans l'envoyer : renvoie les refus prévisibles par Ressource ;
  - diffuser une Actualité : refuse tout si un refus prévisible existe, sinon crée une Publication diffusée par Ressource et renvoie le statut de chacune ;
  - lister l'historique des Publications diffusées d'une Actualité ;
  - relancer une Publication diffusée en échec.
- **Routes du Manager Digital** (interface web). Connexion d'un compte Meta, liste des Intégrations, rattachement et détachement d'une Ressource, déconnexion d'une Intégration. Elles sont authentifiées par session et soumises à `social.manage`. Les contrôles d'accès manquants aujourd'hui sont ajoutés, et l'identifiant utilisateur n'est plus passé en paramètre.
- **Erreurs.** Elles suivent le RFC 9457 (Problem Details), avec un `type` stable par cas. Au minimum : droit manquant, Ressource non rattachée au Site, Intégration expirée ou révoquée (plus aucun accès actif à la Ressource), permission Meta non accordée, image requise pour Instagram, contenu refusé par le réseau, réseau indisponible.
- **Pas de versionnage** des routes en V1.

### Comportements

- **Contenu d'une Diffusion.** Les métadonnées, les textes par Ressource et les images sont envoyés dans la requête. Le Manager Digital les met au format attendu par chaque réseau. Pour Facebook, les images sont envoyées directement. Instagram n'accepte que des URL d'images publiques : le Manager Digital expose donc l'image à une URL publique temporaire le temps de la publication, puis la supprime.
- **Refus prévisibles.** Ce sont ceux qu'on peut déduire sans appeler le réseau : image absente pour Instagram, texte trop long, nombre ou format d'images non accepté, permission Meta manquante, aucune Intégration active. On les vérifie avant tout envoi.
- **Choix de l'accès.** Pour publier sur une page, on utilise le jeton de page obtenu au travers de n'importe quelle Intégration active qui y mène. En cas d'échec d'authentification, on essaie l'Intégration suivante avant de déclarer l'échec.
- **Lecture des Publications.** Elle se fait à la volée chez Meta, avec un cache en mémoire de quelques minutes par Ressource. Rien n'est stocké en base.
- **Permissions Meta demandées.** Celles d'aujourd'hui, plus la lecture du contenu des pages, la publication sur les pages, la lecture des comptes Instagram et la publication Instagram. Toutes sont demandées dès la première connexion.
- **Pas de nouvelle dépendance** de production : le cache est en mémoire, et OAuth est implémenté avec les primitives cryptographiques de Node déjà utilisées pour le state signé et le chiffrement.

## Testing Decisions

- **Ce qu'est un bon test.** Il vérifie un comportement observable par le Plugin WP ou par l'interface du Manager Digital (codes HTTP, corps de réponse, erreurs typées, état après coup), jamais la structure interne. Un refactoring sans changement de comportement ne doit casser aucun test.
- **Frontière unique.** On teste par l'API HTTP du Manager Digital, application Nest réelle et base PostgreSQL de test. Les appels sortants vers la Graph API de Meta sont interceptés au niveau du réseau par un faux Graph qui renvoie des réponses enregistrées. On teste donc aussi la traduction des réponses Meta, sans introduire d'interface « fournisseur RS » pour le seul besoin des tests.
- **Authentification dans les tests.** Le jeton du Plugin WP est obtenu par le vrai parcours OAuth, en se connectant par lien magique. Un test dédié couvre la connexion SSO, avec auth.eness simulé.
- **Scénarios à couvrir en priorité :**
  - une page connectée par deux Intégrations n'apparaît qu'une fois ;
  - une Diffusion réussit encore quand l'une des deux Intégrations a expiré ;
  - un Utilisateur client ne voit et ne rattache que les Ressources des Sites de ses Clients ;
  - un utilisateur sans `social.publish` ne peut pas diffuser ;
  - une Diffusion vers Instagram sans image est bloquée avant tout appel à Meta ;
  - un échec Instagram n'empêche pas la Publication Facebook, et la relance fonctionne ;
  - l'historique survit à la déconnexion de l'Intégration ;
  - un jeton de Plugin WP révoqué est refusé ;
  - un jeton émis pour le Site A ne donne pas accès au Site B.
- **Modules testés.** Les routes du Plugin WP, les routes de gestion des Intégrations et le serveur d'autorisation du Plugin WP, tous via HTTP.
- **Prior art.** Les tests unitaires du module Intégrations, sur le chiffrement et le state signé, avec une configuration factice. Ils restent tels quels. Il n'existe pas encore de test HTTP de bout en bout : Jest et `@nestjs/testing` sont déjà présents. Il faudra ajouter une dépendance de développement pour émettre les requêtes HTTP (supertest, en version stable épinglée).

## Out of Scope

- L'IA : rédaction et correction des Actualités, et emplacement de la clé IA. Tout cela se passe dans le Plugin WP.
- La publicité : comptes publicitaires et métriques de campagne, qui servent au Manager Digital en général.
- Une même Ressource rattachée à plusieurs Sites.
- La programmation d'une Diffusion : elle est immédiate en V1.
- La mise à jour ou la suppression d'une Publication quand son Actualité change.
- La liste unifiée Publications + Diffusions avec tag : prévue à terme, pas en V1.
- Les réseaux autres que Meta.
- Le versionnage de l'API.
- L'affichage dans le Plugin WP et dans l'interface du Manager Digital : messages, boutons de reconnexion.
- La notification par mail des Intégrations expirées : elle attend le module mail.

## Further Notes

- **Prérequis Authentification.** Le module d'Authentification (SSO + lien magique + sessions) n'existe pas encore. Il conditionne le serveur d'autorisation du Plugin WP et les contrôles d'accès des routes de gestion.
- **App Review Meta.** Les nouvelles permissions, en particulier celles de publication, sont soumises à l'App Review de Meta. Il faut prévoir son délai avant la mise en production. En développement, les comptes déclarés testeurs de l'app Meta suffisent.
- **Format des contenus.** On préfère des standards simples et pas trop zélés. Le but est une version fonctionnelle, quitte à réécrire ensuite.
- **Versions.** Toute dépendance ajoutée doit être une version stable, épinglée exactement et vérifiée sur npm, dans le respect des contraintes NestJS 11 et Prisma 7 du projet.
