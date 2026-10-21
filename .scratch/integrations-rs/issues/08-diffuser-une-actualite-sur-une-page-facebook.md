# 08: Diffuser une Actualité sur une page Facebook

**What to build:** Depuis le Plugin WP, un utilisateur qui a `social.publish` diffuse une Actualité vers une page Facebook rattachée à son Site. La requête porte les métadonnées de l'Actualité (dont son identifiant côté WordPress et son lien), le texte et les images. Le Manager Digital les met au format attendu par Facebook et publie immédiatement. Chaque Publication diffusée est tracée : Actualité d'origine, Ressource, texte, statut, identifiant et lien côté Facebook, auteur, dates. La permission de publication sur les pages est ajoutée à la connexion Meta.

**Blocked by:** 07 (Connexion OAuth du Plugin WP)

Décisions (2026-10-21) :
- **Route** `POST /plugin/broadcasts`, en `multipart/form-data` : `actualite` (JSON `{ id, url }`), `targets` (JSON `[{ resourceId, text }]`, un texte par Ressource), `images` (fichiers, 10 au plus, 8 Mo chacun, gardés en mémoire). Réponse 201 `{ publications }`, avec le statut de chacune. Upload par multer, déjà fourni par `@nestjs/platform-express` : aucune dépendance ajoutée.
- **Facebook.** Sans image : `/{page}/feed` avec message et lien. Avec images : photos non publiées envoyées directement, puis un post qui les regroupe (le lien va dans le texte, Facebook n'accepte pas de lien joint). Le lien du post est lu au mieux : à défaut, il est construit à partir de son identifiant.
- **Accès.** Le jeton de page d'une Intégration ACTIVE du Client du Site (ou de l'agence), jamais celui d'un autre Client. Un jeton de page refusé ne marque pas expirée l'Intégration de la personne.
- **Trace** : table `publication`, indépendante des Intégrations ; une Ressource référencée par une Publication n'est plus supprimée à la déconnexion. Échecs tracés avec un `type` stable : `integration-expired`, `permission-missing`, `content-rejected`, `network-unavailable` (dont les limites de débit de Meta), `internal-error`.
- **Droits** : `social.publish` vérifié par la garde du jeton (`@RequiresAnyFeature`), avant la réception des images. Ressource non rattachée au Site : 422 `resource-not-attached` (avec `resourceIds`), rien n'est envoyé.
- Limites laissées aux tickets suivants : type et nombre d'images (09), repli vers une autre Intégration et relance (11), photos non publiées laissées sur la page après un échec du post.

**Status:** done

- [x] Une Diffusion vers une page rattachée crée une Publication sur Facebook, avec le texte, le lien de l'Actualité et les images envoyées
- [x] La Publication diffusée est tracée avec le statut « réussie » et son lien Facebook, et renvoyée dans la réponse
- [x] La Diffusion exige `social.publish` sur le Site du jeton (403 sinon)
- [x] Une Diffusion vers une Ressource non rattachée au Site du jeton est refusée, avec une erreur au `type` stable
- [x] La publication utilise le jeton de page obtenu via une Intégration active qui mène à la page
- [x] La connexion Meta demande la permission de publication sur les pages
- [x] La trace ne dépend pas de l'Intégration utilisée
- [x] Des tests HTTP, avec le faux Graph, vérifient la requête envoyée à Meta et la trace créée
