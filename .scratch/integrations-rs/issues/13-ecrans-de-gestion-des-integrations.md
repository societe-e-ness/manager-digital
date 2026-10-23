# 13: Écrans de gestion des Intégrations

**What to build:** Dans le front du Manager Digital, une page « Réseaux sociaux » permet à un utilisateur qui a `social.manage` de gérer seul les branchements Meta de ses Clients : connecter un compte Meta, voir les Ressources obtenues et leur état, les rattacher à un Site ou les en détacher, déconnecter une Intégration. Les écrans s'appuient sur les routes existantes (tickets 04 à 06). Deux ajouts back sont nécessaires : la liste des Clients et Sites visibles, et un retour de connexion Meta qui revient vers le front au lieu de renvoyer du JSON.

**Contraintes (2026-10-23) :**
- **Une interface pour faire les manipulations, avant tout.** Un minimum d'UI, propre et agréable à regarder, mais vraiment un minimum : pas de design system, pas de bibliothèque de composants, pas de nouvelle dépendance front.
- **Modifications du front tenues au minimum.** Une page (et ce qui lui est strictement nécessaire), dans le style des pages existantes (`HomePage`, `/connexion`, `/autoriser`). Pas de refonte de l'existant, pas de couche d'abstraction (store, client API générique…).

**Blocked by:** 06 (Rattachement et visibilité selon le Client), 07 (pour la page `/connexion`)

Décisions (2026-10-23) :
- **Front** : une seule page `/reseaux-sociaux` (un fichier `.tsx` et un `.css` local préfixé `.rs`), une route, un lien depuis l'accueil. Aucune dépendance ajoutée, aucune autre page modifiée.
- **Retour de Meta** : toujours une redirection vers `/reseaux-sociaux?clientId=…`, avec `connexion=ok` ou `erreur=<type>` (`meta-consent-refused`, `oauth-state-mismatch`, `oauth-state-invalid`, `missing-feature`, `meta-unavailable`, `meta-connection-failed`, `internal-error`). Le Client d'un state usurpé n'est jamais repris dans l'URL. Le front retire ces paramètres une fois le message lu.
- Les Intégrations exposent `created_by` (id, email, nom).
- Limites : les accès de l'agence (sans Client) ne se gèrent pas depuis cette page ; une session expirée pendant le passage chez Meta donne une erreur 401 brute.

**Status:** done

**Back**
- [x] `GET /me/clients` renvoie les Clients visibles par l'utilisateur (tous pour l'agence), avec leurs Sites
- [x] Le retour de connexion Meta redirige vers le front (`/reseaux-sociaux?clientId=…`), avec un indicateur de succès, ou le `type` de l'erreur en cas d'échec
- [x] Des tests HTTP couvrent ces deux comportements

**Front**
- [x] Un utilisateur non connecté est envoyé vers `/connexion`, puis ramené à la page
- [x] L'utilisateur choisit un Client parmi ceux qu'il voit ; s'il n'en a qu'un, il est choisi d'office
- [x] Un bouton « Connecter un compte Meta » lance la connexion pour ce Client ; au retour, la liste est à jour
- [x] Les Ressources du Client s'affichent avec leur type (page, Instagram, publicité) et leur état : rattachée à tel Site, libre, à reconnecter (`accessible: false`) ou rattachée ailleurs
- [x] Une Ressource libre se rattache à un Site du Client (choix dans une liste) ; une Ressource rattachée se détache
- [x] Les Intégrations du Client s'affichent avec la personne qui les a connectées et leur statut ; on peut les resynchroniser et les déconnecter
- [x] Les erreurs de l'API (droit manquant, Ressource déjà rattachée, Intégration d'une autre personne…) s'affichent en clair, à partir de leur `type`

**Hors périmètre**
- La gestion des droits (packs, Fonctionnalités) et des Clients ou Sites eux-mêmes
- Les accès du Plugin WP (liste et révocation) : petit ticket séparé possible, les routes existent déjà
