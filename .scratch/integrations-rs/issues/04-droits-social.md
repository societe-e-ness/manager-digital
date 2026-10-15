# 04: Droits social.read / social.publish / social.manage

**What to build:** Les droits d'un utilisateur sur un Site sont calculés à partir du système existant : packs, surcharges individuelles (où REMOVE l'emporte sur ADD) et plafond des Fonctionnalités du Site. Trois Fonctionnalités sont ajoutées : `social.read` (lister les Publications), `social.publish` (diffuser une Actualité) et `social.manage` (connecter un compte Meta, rattacher ou détacher une Ressource). La gestion des Intégrations exige `social.manage`.

**Blocked by:** 02 (Connexion par lien magique et sessions)

**Status:** ready-for-agent

- [ ] Les trois Fonctionnalités `social.*` sont présentes dans le seed
- [ ] Un utilisateur a une Fonctionnalité sur un Site si un de ses packs ou une surcharge ADD la lui donne, sur ce Site ou sur tous ses Sites, qu'aucune surcharge REMOVE ne la lui retire, et que le Site l'autorise
- [ ] Une Fonctionnalité absente du Site n'est jamais accordée, même par surcharge
- [ ] Un utilisateur n'a aucun droit sur un Site d'un Client auquel il n'appartient pas
- [ ] Un Utilisateur agence a accès à tous les Clients. Ses Fonctionnalités suivent les mêmes règles de packs, surcharges et plafond
- [ ] Les routes de gestion des Intégrations renvoient 403 au format Problem Details sans `social.manage`
- [ ] Des tests HTTP couvrent chaque règle de calcul via une route protégée
