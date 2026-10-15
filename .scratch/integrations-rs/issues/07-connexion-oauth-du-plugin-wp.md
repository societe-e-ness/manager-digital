# 07: Connexion OAuth du Plugin WP

**What to build:** Le Plugin WP se connecte au Manager Digital par OAuth 2.0 (code d'autorisation + PKCE), et le Manager Digital joue le rôle de serveur d'autorisation. L'utilisateur se connecte (session existante, SSO ou lien magique), choisit un Site auquel il a accès et l'autorise. Le Plugin WP reçoit un jeton qui porte la personne et le Site. Première route du Plugin WP : lister les Ressources du Site, avec leur état (accessible ou à reconnecter). Voir [ADR 0002](../../../docs/adr/0002-oauth-pour-le-plugin-wp.md).

**Blocked by:** 02 (Connexion par lien magique et sessions), 04 (Droits social.*), 05 (Une page = une Ressource)

**Status:** ready-for-agent

- [ ] La demande d'autorisation exige un défi PKCE et une URL de retour. Sans eux, elle est refusée
- [ ] Un utilisateur non connecté est d'abord envoyé vers la connexion, puis ramené à l'autorisation
- [ ] L'utilisateur ne peut autoriser qu'un Site d'un Client auquel il appartient (tous les Sites pour l'agence)
- [ ] Le code d'autorisation est à usage unique, de courte durée, et ne s'échange que contre le bon vérificateur PKCE
- [ ] Le jeton délivré est stocké haché et peut être révoqué par l'utilisateur ou par l'agence
- [ ] La route « Ressources du Site » renvoie les Ressources rattachées au Site du jeton, avec leur état, sans aucun jeton Meta
- [ ] Le Site vient toujours du jeton. Un jeton du Site A ne donne jamais accès au Site B
- [ ] Un jeton révoqué ou invalide est refusé (401 au format Problem Details)
- [ ] Des tests HTTP couvrent le parcours OAuth complet, en se connectant par lien magique
