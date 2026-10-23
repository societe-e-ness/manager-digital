# 12: Lister les Publications

**What to build:** Flux entrant, facultatif en V1. Depuis le Plugin WP, un utilisateur qui a `social.read` liste les Publications récentes des Ressources de son Site (pages Facebook et comptes Instagram) : texte, images, date, réseau, lien vers la Publication d'origine. Les Publications sont lues à la volée chez Meta, avec un cache en mémoire de quelques minutes par Ressource, et ne sont pas stockées. Les permissions de lecture du contenu sont ajoutées à la connexion Meta.

**Blocked by:** 07 (Connexion OAuth du Plugin WP)

Décisions (2026-10-23) :
- **Route** `GET /plugin/publications?page=1&limit=20&resourceId=…` (`limit` ≤ 50), qui exige `social.read`. Réponse : `{ publications, page, limit, hasMore, unavailable }`. Chaque Publication : `{ id, network, resourceId, text, images, date, url }`.
- **Fenêtre récente.** Les 50 dernières Publications de chaque page Facebook et de chaque compte Instagram du Site sont fusionnées puis paginées. Ce n'est pas tout l'historique.
- **Cache** de 5 minutes par Ressource, en mémoire. L'accès (Intégration active du Client du Site, ou de l'agence) est revérifié avant de servir le cache.
- **Accès Meta.** Page Facebook : son jeton de page. Compte Instagram : le jeton de la personne.
- **Ressources illisibles.** Elles sont listées dans `unavailable` (`{ resourceId, type }`). Si aucune n'est lisible : erreur Problem Details (`integration-expired` ou `permission-missing` en 409, panne de Meta en 502), avec le détail par Ressource.
- **Permissions Meta ajoutées** : `pages_read_user_content`, `instagram_basic`.

**Status:** done

- [x] La route renvoie les Publications des Ressources rattachées au Site du jeton, triées de la plus récente à la plus ancienne
- [x] Chaque Publication porte son texte, ses images, sa date, son réseau, sa Ressource et son lien d'origine
- [x] La liste est paginée
- [x] Deux appels rapprochés pour la même Ressource ne déclenchent qu'un appel à Meta (cache court)
- [x] La route exige `social.read` sur le Site du jeton (403 sinon)
- [x] Une Ressource sans Intégration active renvoie une erreur au `type` stable « Intégration expirée », pas une liste vide
- [x] La connexion Meta demande les permissions de lecture du contenu des pages et des comptes Instagram
- [x] Des tests HTTP, avec le faux Graph, couvrent la traduction des réponses Meta, la pagination et le cache
