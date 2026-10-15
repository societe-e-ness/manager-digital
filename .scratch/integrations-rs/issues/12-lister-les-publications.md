# 12: Lister les Publications

**What to build:** Flux entrant, facultatif en V1. Depuis le Plugin WP, un utilisateur qui a `social.read` liste les Publications récentes des Ressources de son Site (pages Facebook et comptes Instagram) : texte, images, date, réseau, lien vers la Publication d'origine. Les Publications sont lues à la volée chez Meta, avec un cache en mémoire de quelques minutes par Ressource, et ne sont pas stockées. Les permissions de lecture du contenu sont ajoutées à la connexion Meta.

**Blocked by:** 07 (Connexion OAuth du Plugin WP)

**Status:** ready-for-agent

- [ ] La route renvoie les Publications des Ressources rattachées au Site du jeton, triées de la plus récente à la plus ancienne
- [ ] Chaque Publication porte son texte, ses images, sa date, son réseau, sa Ressource et son lien d'origine
- [ ] La liste est paginée
- [ ] Deux appels rapprochés pour la même Ressource ne déclenchent qu'un appel à Meta (cache court)
- [ ] La route exige `social.read` sur le Site du jeton (403 sinon)
- [ ] Une Ressource sans Intégration active renvoie une erreur au `type` stable « Intégration expirée », pas une liste vide
- [ ] La connexion Meta demande les permissions de lecture du contenu des pages et des comptes Instagram
- [ ] Des tests HTTP, avec le faux Graph, couvrent la traduction des réponses Meta, la pagination et le cache
