# Le Plugin WP se connecte au Manager Digital par OAuth 2.0

Le Plugin WP obtient son accès à l'API par OAuth 2.0 (code d'autorisation + PKCE). Le Manager Digital joue le rôle de serveur d'autorisation : l'utilisateur s'y connecte (SSO, ou lien magique en secours) puis autorise le Site. Le jeton obtenu identifie à la fois la personne et le Site. Une clé d'API par Site, plus simple, a été écartée : elle n'identifie pas la personne, et elle laisse dans la base WordPress un secret suffisant pour publier sur les réseaux sociaux du Client.
