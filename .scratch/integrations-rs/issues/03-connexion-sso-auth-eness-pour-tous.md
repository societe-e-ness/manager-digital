# 03: Connexion SSO auth.eness pour tous

**What to build:** Tout le monde, Utilisateur agence comme Utilisateur client, se connecte par le SSO de l'agence (auth.eness). Le lien magique reste disponible en secours. Le type d'utilisateur ne détermine plus la méthode de connexion. Voir [ADR 0001](../../../docs/adr/0001-sso-pour-tous-lien-magique-en-secours.md).

**Blocked by:** 02 (Connexion par lien magique et sessions)

**Status:** ready-for-agent

- [ ] Un utilisateur est redirigé vers auth.eness, puis revient avec une session (méthode : SSO)
- [ ] À la première connexion SSO, l'utilisateur est retrouvé par son email et son identifiant SSO est enregistré, y compris pour un Utilisateur client
- [ ] Une identité SSO sans utilisateur connu dans le Manager Digital est refusée, sans création automatique de compte
- [ ] Les connexions suivantes retrouvent l'utilisateur par son identifiant SSO
- [ ] Le lien magique fonctionne toujours, pour tous les types d'utilisateur
- [ ] Le schéma et ses commentaires ne lient plus le type d'utilisateur à la méthode de connexion
- [ ] Les variables de configuration SSO sont validées au démarrage et documentées dans l'exemple d'environnement
- [ ] Un test HTTP couvre la connexion SSO avec auth.eness simulé
