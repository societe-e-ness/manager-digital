# 03: Connexion SSO auth.eness pour tous

**What to build:** Tout le monde, Utilisateur agence comme Utilisateur client, se connecte par le SSO de l'agence (auth.eness, OpenID Connect, code d'autorisation + PKCE). Le lien magique reste disponible en secours. Le type d'utilisateur ne détermine plus la méthode de connexion. Voir [ADR 0001](../../../docs/adr/0001-sso-pour-tous-lien-magique-en-secours.md) et le guide d'intégration d'auth.eness.

Décisions (2026-10-16) :
- **Comptes inconnus refusés.** Un compte auth.eness inconnu du Manager Digital est refusé : les utilisateurs sont créés à la main. À la première connexion, on retrouve la personne par son email, puis par son `sub`.
- **Rôles.** Le service déclare `lecteur`, `editeur` et `admin`. Les Utilisateurs client reçoivent `lecteur`, les Utilisateurs agence `admin`. Le rôle est lu à chaque connexion et gardé dans la session, jamais dans la table des utilisateurs. Un rôle absent ou inconnu vaut refus. Il ne sert pas encore à autoriser des actions : les droits passent par les Fonctionnalités (ticket 04).
- **Type d'utilisateur.** Le type agence / client reste géré dans le Manager Digital. Le claim `type` d'auth.eness est ignoré, mais une incohérence est signalée dans les logs.
- **Suivi des changements dans auth.eness.** La session est revérifiée auprès d'auth.eness toutes les 10 minutes (refresh token), et le back-channel logout est pris en charge.

**Blocked by:** 02 (Connexion par lien magique et sessions)

**Status:** done

- [x] Un utilisateur est redirigé vers auth.eness, avec `state`, `nonce`, PKCE et `resource`, puis revient avec une session (méthode : SSO) et est renvoyé vers le front (chemin local uniquement)
- [x] À la première connexion SSO, l'utilisateur est retrouvé par son email et son `sub` est enregistré, y compris pour un Utilisateur client. Ensuite, il est retrouvé par son `sub`
- [x] Une identité SSO sans utilisateur connu dans le Manager Digital est refusée, sans création automatique de compte
- [x] Un rôle absent ou inconnu est refusé
- [x] Un `state` falsifié ou un retour sans aller est refusé
- [x] Toutes les 10 minutes, la session SSO est revérifiée. Si l'accès a été retiré dans auth.eness, la session est révoquée
- [x] Un back-channel logout signé révoque les sessions liées à la session SSO concernée. Un jeton non signé ou mal signé est refusé
- [x] La déconnexion d'une session SSO renvoie l'URL de fin de session d'auth.eness
- [x] Le lien magique fonctionne toujours, pour tous les types d'utilisateur
- [x] Le schéma et ses commentaires ne lient plus le type d'utilisateur à la méthode de connexion
- [x] Les variables de configuration SSO sont validées au démarrage et documentées dans l'exemple d'environnement. Sans SSO activé, l'application démarre
- [x] Des tests HTTP couvrent ces cas avec auth.eness simulé
