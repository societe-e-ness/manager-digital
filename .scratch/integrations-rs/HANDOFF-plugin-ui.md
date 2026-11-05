# Passation : interface du Plugin WP (réseaux sociaux)

Ce document s'adresse à l'agent qui construit, dans le **Plugin WP**, les écrans qui utilisent l'API du **Manager Digital**. Il explique ce que le plugin doit faire, le contrat d'API à respecter, et l'état d'avancement du back.

## 1. Le contexte

- **Manager Digital** est l'API de l'agence (NestJS). Elle détient les connexions aux comptes Meta des Clients. Le **Plugin WP**, installé sur le site WordPress d'un Client, l'appelle pour **diffuser des Actualités** sur la page Facebook et le compte Instagram de ce Client, et pour **afficher les Publications récentes**.
- Le plugin ne parle **jamais directement à Meta**. Il n'a aucun jeton Meta : uniquement un jeton du Manager Digital, qui porte **une personne et un Site**.
- Le branchement des comptes Meta et le rattachement des pages aux Sites se font **dans le Manager Digital** (page `/reseaux-sociaux`), pas dans le plugin. Le plugin peut seulement y renvoyer par un lien.

Vocabulaire à respecter, dans l'interface comme dans le code (voir `GLOSSARY.md` du dépôt manager-digital) :

| Terme | Sens |
|---|---|
| **Actualité** | un article WordPress à diffuser |
| **Ressource** | une page Facebook ou un compte Instagram rattaché au Site |
| **Diffusion** | l'envoi d'une Actualité vers une ou plusieurs Ressources |
| **Publication** | le post créé sur une Ressource, avec son statut |
| **Intégration** | une connexion à un compte Meta, gérée dans le Manager Digital |

Références dans le dépôt manager-digital : `docs/specs/integrations-rs.md` (récits utilisateurs 1 à 10 et 27 à 47), `docs/adr/0002-oauth-pour-le-plugin-wp.md`, et les tickets `.scratch/integrations-rs/issues/`. Les contrats sont aussi documentés en tête de `server/src/core/plugin-social/plugin-social.controller.ts` et de `server/src/core/plugin-auth/plugin-auth.controller.ts`.

## 2. Les écrans à construire

Garde une **interface minimale** : les composants natifs de l'admin WordPress, sans framework front ajouté sans en parler. L'objectif est de pouvoir faire les manipulations, avec juste assez de soin pour que ce soit agréable à voir.

1. **Connexion au Manager Digital** (page de réglages du plugin) :
   - non connecté : un bouton « Connecter au Manager Digital » ;
   - connecté : un message « Connecté », et un bouton « Déconnecter » qui révoque le jeton puis l'efface ;
   - si l'API répond `plugin-token-invalid`, on repasse en non connecté avec le message « reconnectez le plugin ».
2. **Diffuser une Actualité** (depuis l'édition d'un article, ou une page dédiée) :
   - la liste des Ressources du Site, à cocher. Une Ressource avec `accessible: false` est grisée, avec la mention « connexion Meta à renouveler dans le Manager Digital » ;
   - un **texte par Ressource cochée**, prérempli avec l'extrait de l'article ;
   - les images, prises dans la médiathèque WordPress ;
   - le lien de l'article, ajouté automatiquement ;
   - après l'envoi, le **résultat par Ressource** : réussie, avec le lien vers le post, ou échouée, avec la raison.
3. **Publications récentes** :
   - une liste paginée (texte, images, date, réseau, lien vers l'original), avec un filtre facultatif par Ressource ;
   - si certaines Ressources n'ont pas pu être lues, un bandeau discret qui le signale.

## 3. Le contrat d'API

**URL de base** : `https://manager-digital-nine.vercel.app/api` en recette, `http://localhost:3000` en local. Rends-la configurable (constante ou réglage).

**Format des erreurs** : toutes les erreurs suivent le format RFC 9457, en `application/problem+json` :

```json
{ "type": "missing-feature", "title": "Droit manquant", "status": 403, "detail": "Fonctionnalité social.publish requise", "feature": "social.publish" }
```

Le champ **`type` est stable** : base tes messages sur lui, jamais sur `title` ni sur `detail`. Les champs propres à chaque erreur, comme `feature` ou `resourceIds`, sont placés au premier niveau de l'objet.

### 3.1 Connexion (OAuth 2.0, code d'autorisation + PKCE S256)

C'est un client OAuth public, sans secret. `client_id = wp-plugin`. Le jeton délivré **n'expire pas** : il n'y a pas de rafraîchissement, mais il peut être révoqué.

1. **Le plugin (en PHP) génère** :
   - un `code_verifier` aléatoire (43 à 128 caractères) ;
   - `code_challenge = base64url(sha256(code_verifier))`, sans `=` ;
   - un `state` aléatoire.

   Il garde `code_verifier` et `state` côté serveur, par exemple dans un transient lié à l'utilisateur WordPress, pendant une dizaine de minutes.
2. **Il redirige le navigateur** vers :
   `GET {API}/oauth/authorize?response_type=code&client_id=wp-plugin&redirect_uri={URL de retour}&code_challenge={…}&code_challenge_method=S256&state={…}`
   - `redirect_uri` doit être une URL **du domaine du Site** tel qu'il est déclaré dans le Manager Digital (avec ou sans `www.`), en **HTTPS** (HTTP n'est accepté qu'hors production), et sans fragment `#`. Par exemple : `https://site-du-client.fr/wp-admin/admin.php?page=manager-digital-callback`.
   - Si le domaine n'est pas connu du Manager Digital, l'API répond 400 `oauth-invalid-request`, **sans redirection**.
3. Le Manager Digital affiche la connexion (SSO ou lien magique), puis la page « Autoriser » où l'utilisateur choisit le Site. Il redirige ensuite vers `redirect_uri` :
   - si l'utilisateur accepte : `?code=…&state=…` ;
   - s'il refuse : `?error=access_denied&state=…`.
4. **Le gestionnaire de retour** vérifie `state`, puis échange le code **de serveur à serveur**, en PHP (le code est à usage unique et valable 5 minutes) :
   ```
   POST {API}/oauth/token        (JSON ou application/x-www-form-urlencoded)
   grant_type=authorization_code&client_id=wp-plugin&code=…&redirect_uri={exactement la même}&code_verifier=…
   → 200 { "access_token": "…", "token_type": "Bearer" }
   ```
   En cas d'erreur : 400 `oauth-invalid-grant` (code expiré, déjà utilisé, ou PKCE faux), avec en plus le champ `error` du RFC 6749.
5. **Il stocke le jeton** dans les options WordPress (`autoload` désactivé). Le jeton ne doit **jamais être envoyé au navigateur**.
6. **Déconnexion** : `POST {API}/oauth/revoke` avec `{ "token": "…" }`, qui répond 200 dans tous les cas, puis effacement du jeton côté WordPress.

Une nouvelle autorisation pour la même personne et le même Site révoque l'ancienne.

### 3.2 Les routes du plugin (en-tête `Authorization: Bearer {jeton}`)

Le Site vient du jeton : on ne le passe **jamais** en paramètre.

**`GET /plugin/resources`** : les Ressources rattachées au Site. Droit requis : `social.read` ou `social.publish`.
```json
[{ "id": 12, "provider": "META", "type": "FACEBOOK_PAGE", "name": "Boulangerie Martin", "external_id": "1029…",
   "parent_id": null, "site_id": 3, "metadata": { "category": "Boulangerie" }, "accessible": true,
   "attached_elsewhere": false, "last_synced_at": "…", "last_error": null, "created_at": "…" }]
```
`type` vaut `FACEBOOK_PAGE`, `INSTAGRAM_ACCOUNT` ou `AD_ACCOUNT`. N'affiche pas les `AD_ACCOUNT` dans la Diffusion.

**`POST /plugin/broadcasts`** : diffuse une Actualité. Droit requis : `social.publish`. La requête est en `multipart/form-data` :

| Champ | Contenu |
|---|---|
| `actualite` | une chaîne JSON `{"id":"42","url":"https://site/mon-article"}` (l'id de l'article WordPress) |
| `targets` | une chaîne JSON `[{"resourceId":12,"text":"…"}]`, avec un texte par Ressource et sans doublon |
| `images` | des fichiers, champ répété, facultatif : **10 au plus, 8 Mo chacun** |

La réponse est `201 { "publications": [ … ] }`, avec **une entrée par Ressource** :
```json
{ "id": 7, "resource_id": 12, "status": "SUCCEEDED", "network_url": "https://facebook.com/…", "network_post_id": "…",
  "error_type": null, "error_detail": null, "text": "…", "article_id": "42", "article_url": "…",
  "created_at": "…", "published_at": "…" }
```
`status` vaut `SUCCEEDED` ou `FAILED`. **Un échec sur une Ressource n'empêche pas les autres** : affiche donc le résultat ligne par ligne. Si le statut est `FAILED`, `error_type` donne la raison (voir le tableau du 3.3).

Pour l'instant, seules les **pages Facebook** sont acceptées. Viser un compte Instagram renvoie 422 `resource-type-unsupported` (Instagram arrive avec le ticket 10).

**`GET /plugin/publications?page=1&limit=20&resourceId=12`** : les Publications récentes, lues chez Meta, avec quelques minutes de cache. Droit requis : `social.read`. `limit` vaut 50 au plus, et `resourceId` est facultatif.
```json
{ "publications": [{ "id": "…", "network": "facebook", "text": "…", "images": ["https://…"], "date": "2026-11-04T09:12:00+0000",
                     "url": "https://…", "resourceId": 12 }],
  "page": 1, "limit": 20, "hasMore": true, "unavailable": [{ "resourceId": 15, "type": "integration-expired" }] }
```
- `unavailable` liste les Ressources qui n'ont pas pu être lues : c'est le bandeau discret.
- Si **aucune** Ressource n'a pu être lue, l'API répond par une erreur : 409 `integration-expired` ou `permission-missing`, sinon 502 ou 500.

### 3.3 Les erreurs à traiter dans l'interface

| `type` | HTTP | Message suggéré |
|---|---|---|
| `plugin-token-invalid` | 401 | Le plugin n'est plus connecté au Manager Digital : reconnectez-le. (Effacer le jeton.) |
| `missing-feature` | 403 | Vous n'avez pas le droit de consulter / diffuser (champ `feature`). Masquer l'action concernée. |
| `resource-not-attached` | 422 | Une Ressource choisie n'est plus rattachée au Site : rechargez la liste. |
| `resource-type-unsupported` | 422 | Ce type de compte ne peut pas encore recevoir de Diffusion. |
| `broadcast-invalid-request` | 400 | Bogue côté plugin (formulaire mal construit) : afficher `detail` en mode débogage. |
| `integration-expired` | 409, ou `error_type` | La connexion Meta qui mène à cette page a expiré : renouvelez-la dans le Manager Digital. |
| `permission-missing` | 409, ou `error_type` | Une permission Meta n'a pas été accordée : reconnectez le compte Meta dans le Manager Digital. |
| `content-rejected` | `error_type` | Facebook a refusé ce contenu. |
| `network-unavailable` | `error_type` | Meta est indisponible pour le moment : réessayez plus tard. |
| `internal-error` | 500, ou `error_type` | Erreur du Manager Digital : réessayez, ou contactez l'agence. |

Un `type` inconnu doit toujours donner un message générique, sans plantage : de nouveaux types vont arriver.

## 4. Ce qui arrive côté API (prévois la place, ne le code pas encore)

| Ticket | Ce que ça ajoutera | Conséquence pour l'interface |
|---|---|---|
| 09 | Une route de **vérification sans envoi**, au même format multipart, qui renvoie les refus prévisibles par Ressource (texte trop long, images non acceptées, permission manquante…). Une Diffusion qui contient un refus sera rejetée en entier. | Avant l'envoi, afficher les refus sous chaque Ressource et désactiver le bouton « Diffuser ». |
| 10 | Les **comptes Instagram** comme cible, avec une image obligatoire. | Ne réserve pas le formulaire à Facebook. Une Ressource Instagram sans image sera un refus. |
| 11 | La **relance** d'une Publication échouée et l'**historique** des Publications d'une Actualité. | Prévoir un bouton « Relancer » sur une ligne échouée, et un bloc « Déjà diffusée sur… » dans l'article. |

Les routes exactes seront fixées dans les sections « Décisions » de ces tickets. Les contrats actuels ne changeront pas : ces tickets ajoutent des routes et des champs.

## 5. Pièges connus

- **Appelle l'API depuis PHP uniquement**, via `wp_remote_get` / `wp_remote_post`, jamais depuis le JavaScript du navigateur. Le jeton ne doit pas fuir, et l'API n'autorise pas les appels d'autres origines (CORS).
- **Multipart en PHP** : `wp_remote_post` ne construit pas de multipart à partir d'un tableau. Il faut monter le corps soi-même (frontière, en-têtes de chaque partie), ou passer par cURL avec `CURLFile`.
- **Délais** : une Diffusion avec images peut prendre plusieurs secondes. Le délai par défaut de `wp_remote_*` (5 s) est trop court : prévois environ 60 s pour `/plugin/broadcasts`.
- **Droits** : aucune route ne donne à l'avance les droits de l'utilisateur. C'est la réponse 403 `missing-feature` qui les révèle, ce qui permet de masquer ensuite le bouton concerné. Si une route « mes droits sur ce Site » devient vraiment nécessaire, **demande-la** à l'utilisateur, qui l'ajoutera côté API.
- **Retour OAuth** : vérifie `nonce`, `state` et les capacités WordPress (`current_user_can`) sur le gestionnaire de retour.
- **Plusieurs utilisateurs WordPress** : le jeton porte **une personne** du Manager Digital. Avant de coder, décide avec l'utilisateur s'il doit y avoir un jeton par Site (dans une option) ou un jeton par utilisateur WordPress (dans les métadonnées de l'utilisateur).

## 6. Comment travailler (l'esprit du projet)

- **Propose avant d'appliquer.** Présente le plan des écrans, puis chaque modification structurante, et attends un « oui » avant de coder. Pose la question dès qu'un choix n'est pas tranché ici, par exemple jeton par Site ou par utilisateur, ou emplacement de l'écran de Diffusion.
- **Pragmatique.** Une V1 qui fonctionne d'abord : pas d'abstraction prématurée, et pas de zèle sur les standards.
- **Interface minimale.** Juste assez jolie, en réutilisant les styles de l'admin WordPress, avec le moins de code front possible.
- **Dépendances.** Des versions stables et épinglées. Pas de nouvelle dépendance sans en parler, et jamais de version `latest`, bêta ou RC.
- **Erreurs.** Teste le `type`, jamais le texte. Prévois toujours un message générique pour un `type` inconnu.
- **Git.** Commits sur la branche courante. Ne pousse pas et ne déploie pas sans l'utilisateur.
- **Langue.** Code et identifiants en anglais. Interface, commentaires et échanges avec l'utilisateur en **français**, avec des réponses concises.
