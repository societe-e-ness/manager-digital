# 09: Refus prévisibles avant Diffusion

**What to build:** Avant de diffuser, le Plugin WP peut demander une vérification sans envoi. Elle renvoie, pour chaque Ressource cible, les refus prévisibles : ceux qu'on peut déduire sans appeler le réseau. Une Diffusion qui contient au moins un refus prévisible est entièrement bloquée, et rien ne part vers Meta. Le Plugin WP peut ainsi prévenir l'utilisateur et l'empêcher de lancer l'action.

**Blocked by:** 08 (Diffuser une Actualité sur une page Facebook)

Décisions (2026-11-12) :
- **Route** `POST /plugin/broadcasts/check` : exactement la même requête multipart que `POST /plugin/broadcasts` (un seul formulaire côté Plugin WP), vérifiée sans rien envoyer à Meta ni tracer. Exige `social.publish`. Réponse 200 `{ ok, targets: [{ resourceId, refusals: [{ type, detail, … }] }] }`.
- **Diffusion** : la même vérification passe en premier. Au moindre refus, 422 `broadcast-refused` avec le même `targets` : rien ne part, aucune Publication n'est tracée, même pour les cibles valides. Sans refus : comportement du ticket 08.
- **Refus** (types stables), dans cet ordre par Ressource : `resource-type-unsupported` (type qu'on ne diffuse pas encore : Instagram jusqu'au 10, comptes publicitaires), `integration-expired` (aucune Intégration active du Client ne mène à la page), `permission-missing` (aucune ne l'a accordée ; `requiredScopes`), `text-too-long` (`maxLength`), `too-many-images` (`maxImages`), `image-format-unsupported` (`images`, `acceptedTypes`), `image-too-large` (`images`, `maxBytes`). `integration-expired` et `permission-missing` reprennent les types des échecs du ticket 08.
- **Une Ressource non rattachée au Site** reste une demande invalide, pas un refus : 422 `resource-not-attached`, inchangé, sur les deux routes.
- **Règles Facebook** (`broadcast-rules.ts`), d'après la doc Graph API (Page Photos, Page Feed) : permissions `pages_manage_posts`, `pages_read_engagement`, `pages_show_list` (une seule constante `PAGE_PUBLISH_SCOPES`, partagée avec la connexion Meta) ; images JPEG, PNG, GIF, BMP, TIFF de 4 Mo au plus. **Non documentés par Meta** : la longueur du texte (63 206, limite connue des posts Facebook, comptée en unités UTF-16, le plus strict) et le nombre de photos par post (10, limite du Manager Digital).
- **Publication** : l'accès utilisé est celui d'une Intégration active qui a accordé les permissions de publication (une autre Intégration active sans elles est ignorée).
- **Limites assumées** : les permissions vérifiées sont celles enregistrées à la connexion Meta (un retrait côté Facebook depuis n'est vu qu'à l'envoi, comme un échec : ticket 11) ; le format d'image est le type MIME annoncé par le Plugin WP (une image mal étiquetée sera refusée par Meta, et tracée) ; au-delà de 20 fichiers ou de 8 Mo par fichier, garde-fous techniques de l'upload (400 / 413, pas un refus) ; sur Vercel, une requête est de toute façon limitée à 4,5 Mo.

**Status:** done

- [x] La route de vérification renvoie, par Ressource cible, la liste des refus prévisibles, chacun avec un `type` stable
- [x] Les refus détectés comprennent au moins : permission Meta non accordée, aucune Intégration active vers la Ressource, texte trop long pour le réseau, format ou nombre d'images non accepté
- [x] Une Diffusion avec au moins un refus prévisible est rejetée en entier (erreur Problem Details listant les refus), sans aucun appel à Meta
- [x] Une Diffusion sans refus prévisible se comporte comme dans le ticket 08
- [x] Des tests HTTP couvrent chaque refus, et vérifient que le faux Graph n'a reçu aucun appel
