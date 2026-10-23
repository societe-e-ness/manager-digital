# SSO pour tout le monde, lien magique en secours

Tous les utilisateurs, agence comme clients, se connectent par le SSO de l'agence (auth.eness). Le lien magique reste ouvert à tous, mais seulement comme solution de secours quand le SSO est en panne ou en maintenance. On a écarté le modèle d'origine (SSO pour l'agence, lien magique pour les clients) pour n'avoir qu'un parcours de connexion principal, sans perdre l'accès quand le SSO tombe.

## Conséquences

- Le type d'utilisateur (`AGENCY` / `CLIENT`) ne décide plus de la méthode de connexion. Il faut corriger le schéma et ses commentaires, qui disent l'inverse.
- Un Utilisateur client a lui aussi un compte sur auth.eness.
