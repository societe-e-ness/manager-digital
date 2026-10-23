# Cadrage : connexion aux réseaux sociaux (Meta)

Vocabulaire : voir [GLOSSARY.md](../../GLOSSARY.md).

## Périmètre

L'API du Manager Digital donne au Plugin WP un accès aux réseaux sociaux d'un Site, dans deux sens :

- **Flux entrant** (facultatif en V1) : lister dans le Plugin WP les Publications existantes des Ressources du Site. Elles ne sont jamais publiées sur le Site. À terme, Publications et Diffusions apparaîtront dans une même liste, distinguées par un tag.
- **Flux sortant** : la Diffusion d'une Actualité rédigée dans le Plugin WP vers les Ressources du Site, sous forme de Publications.

Hors périmètre :

- **L'IA.** La rédaction assistée tourne dans le Plugin WP, hors de cette API. Où vit la clé IA n'est pas un sujet pour l'instant : en test, on utilise le compte Claude de l'agence.
- **La publicité.** Les comptes publicitaires et les métriques de campagne servent au Manager Digital en général, pas à cette fonctionnalité.

## Décisions

- **Connexion à Meta.** Un Utilisateur agence ou un Utilisateur client peut connecter un compte Meta.
- **Accès aux Ressources.** Un utilisateur voit les Ressources rattachées aux Sites des Clients auxquels il appartient, quelle que soit la personne qui a fait la connexion.
- **Un Site par Ressource.** Une Ressource est rattachée à un seul Site au plus. Le partage d'une Ressource entre plusieurs Sites est hors de portée.
- **Rattachement Ressource → Site.** Tout utilisateur, agence ou client, qui a `social.manage`. L'Utilisateur client est ainsi autonome.
- **Connexion du Plugin WP.** Le Plugin WP se connecte par OAuth 2.0 (code d'autorisation + PKCE), et non par son domaine. Le jeton porte l'utilisateur et le Site. Voir [ADR 0002](../adr/0002-oauth-pour-le-plugin-wp.md).
- **Erreurs.** Elles suivent le RFC 9457 (Problem Details), avec un `type` stable que le Plugin WP peut tester.
- **Versionnage.** L'API n'est pas versionnée en V1. On vise une version fonctionnelle, quitte à réécrire ensuite.
- **Authentification.** Tout le monde se connecte par le SSO de l'agence. Le lien magique reste disponible en secours, quand le SSO est indisponible. Voir [ADR 0001](../adr/0001-sso-pour-tous-lien-magique-en-secours.md).
- **Ressources partagées entre Intégrations.** Une page connectée par plusieurs personnes est une seule Ressource. N'importe quelle Intégration active qui y donne accès peut servir, ce qui rend le système robuste à l'expiration de l'une d'elles.
- **Intégration expirée.** L'API renvoie une erreur explicite. L'affichage relève du Plugin WP et du front.
- **Publications listées.** Elles sont lues à la volée chez Meta, avec un cache court, et ne sont pas stockées.
- **Droits.** Trois Fonctionnalités, plafonnées par Site : `social.read` (lister les Publications), `social.publish` (diffuser une Actualité) et `social.manage` (connecter un compte Meta, rattacher ou détacher une Ressource).
- **Publications figées.** Une Publication ne suit pas les modifications ou la suppression de son Actualité (V1).
- **Déconnexion.** On ne déconnecte que ses propres Intégrations. L'agence peut tout déconnecter. Un Utilisateur client peut détacher une Ressource de son Site.
- **Historique des Diffusions.** La trace d'une Publication diffusée se rattache à l'Actualité et à la Ressource, et survit à la déconnexion de l'Intégration qui l'a envoyée.
- **Permissions Meta.** Toutes les permissions sont demandées dès la première connexion, y compris la lecture du contenu des Publications (texte et médias).
- **Déroulé d'une Diffusion.** L'utilisateur choisit explicitement les Ressources cibles, et la Diffusion est immédiate.
- **Refus prévisibles.** Si un réseau va refuser une Publication (par exemple Instagram sans image), on le dit à l'utilisateur avant la Diffusion, et l'action est bloquée.
- **Format des contenus.** Textes et images sont mis en forme selon ce que demande l'API de chaque réseau. On préfère des standards simples, pas trop zélés.
- **Échec d'une Diffusion.** Pour les erreurs imprévisibles (jeton révoqué, panne Meta) : l'Actualité reste publiée sur le Site. Chaque Publication diffusée est tracée avec son statut (réussie, ou échouée avec sa raison) et peut être relancée.
