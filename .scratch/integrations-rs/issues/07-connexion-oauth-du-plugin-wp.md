# 07: Connexion OAuth du Plugin WP

**What to build:** Le Plugin WP se connecte au Manager Digital par OAuth 2.0 (code d'autorisation + PKCE), et le Manager Digital joue le rôle de serveur d'autorisation. L'utilisateur se connecte (session existante, SSO ou lien magique), choisit un Site auquel il a accès et l'autorise. Le Plugin WP reçoit un jeton qui porte la personne et le Site. Première route du Plugin WP : lister les Ressources du Site, avec leur état (accessible ou à reconnecter). Voir [ADR 0002](../../../docs/adr/0002-oauth-pour-le-plugin-wp.md).

**Blocked by:** 02 (Connexion par lien magique et sessions), 04 (Droits social.*), 05 (Une page = une Ressource)

Décisions (2026-10-21) :
- **Routes.** `GET /oauth/authorize` (valide puis envoie vers le front `/autoriser`, ou `/connexion?returnTo=…`), `GET`/`POST /oauth/consent` (choix du Site, session), `POST /oauth/token`, `POST /oauth/revoke` (RFC 7009), `GET`/`DELETE /oauth/authorizations` (révocation par la personne ou l'agence). Première route du Plugin WP : `GET /plugin/resources`.
- **Client unique** `wp-plugin`, public : PKCE S256 obligatoire, pas de secret.
- **URL de retour.** Elle doit mener à un Site connu (sinon 400, même pour un refus : pas de redirection ouverte), et seul ce Site est autorisable. Le code ne part ainsi jamais ailleurs que sur le Site autorisé. HTTP accepté hors production (WordPress local).
- **Jeton** opaque, haché, sans expiration mais révocable ; une nouvelle autorisation révoque la précédente pour la même personne et le même Site. L'appartenance au Client est revérifiée à chaque appel. Un accès retiré dans auth.eness révoque aussi les autorisations, quand la revérification SSO le constate.
- **`/plugin/resources`** exige `social.read` ou `social.publish` sur le Site du jeton.
- **Lien magique** : il transporte `returnTo` (chemin local). Pages front minimales `/connexion` et `/autoriser`.
- Limite connue : le rejeu d'un code déjà échangé est refusé mais ne révoque pas le jeton émis (PKCE rend un code intercepté inutilisable).

**Status:** done

- [x] La demande d'autorisation exige un défi PKCE et une URL de retour. Sans eux, elle est refusée
- [x] Un utilisateur non connecté est d'abord envoyé vers la connexion, puis ramené à l'autorisation
- [x] L'utilisateur ne peut autoriser qu'un Site d'un Client auquel il appartient (tous les Sites pour l'agence)
- [x] Le code d'autorisation est à usage unique, de courte durée, et ne s'échange que contre le bon vérificateur PKCE
- [x] Le jeton délivré est stocké haché et peut être révoqué par l'utilisateur ou par l'agence
- [x] La route « Ressources du Site » renvoie les Ressources rattachées au Site du jeton, avec leur état, sans aucun jeton Meta
- [x] Le Site vient toujours du jeton. Un jeton du Site A ne donne jamais accès au Site B
- [x] Un jeton révoqué ou invalide est refusé (401 au format Problem Details)
- [x] Des tests HTTP couvrent le parcours OAuth complet, en se connectant par lien magique
