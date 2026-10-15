# 08: Diffuser une Actualité sur une page Facebook

**What to build:** Depuis le Plugin WP, un utilisateur qui a `social.publish` diffuse une Actualité vers une page Facebook rattachée à son Site. La requête porte les métadonnées de l'Actualité (dont son identifiant côté WordPress et son lien), le texte et les images. Le Manager Digital les met au format attendu par Facebook et publie immédiatement. Chaque Publication diffusée est tracée : Actualité d'origine, Ressource, texte, statut, identifiant et lien côté Facebook, auteur, dates. La permission de publication sur les pages est ajoutée à la connexion Meta.

**Blocked by:** 07 (Connexion OAuth du Plugin WP)

**Status:** ready-for-agent

- [ ] Une Diffusion vers une page rattachée crée une Publication sur Facebook, avec le texte, le lien de l'Actualité et les images envoyées
- [ ] La Publication diffusée est tracée avec le statut « réussie » et son lien Facebook, et renvoyée dans la réponse
- [ ] La Diffusion exige `social.publish` sur le Site du jeton (403 sinon)
- [ ] Une Diffusion vers une Ressource non rattachée au Site du jeton est refusée, avec une erreur au `type` stable
- [ ] La publication utilise le jeton de page obtenu via une Intégration active qui mène à la page
- [ ] La connexion Meta demande la permission de publication sur les pages
- [ ] La trace ne dépend pas de l'Intégration utilisée
- [ ] Des tests HTTP, avec le faux Graph, vérifient la requête envoyée à Meta et la trace créée
