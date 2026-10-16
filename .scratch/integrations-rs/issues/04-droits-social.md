# 04: Droits social.read / social.publish / social.manage

**What to build:** Les droits d'un utilisateur sur un Site sont calculés à partir du système existant : packs, surcharges individuelles (où REMOVE l'emporte sur ADD) et plafond des Fonctionnalités du Site. Trois Fonctionnalités sont ajoutées : `social.read` (lister les Publications), `social.publish` (diffuser une Actualité) et `social.manage` (connecter un compte Meta, rattacher ou détacher une Ressource). La gestion des Intégrations exige `social.manage`.

**Blocked by:** 02 (Connexion par lien magique et sessions)

Décisions (2026-10-16) :
- **Portée du contrôle.** Rattacher ou détacher une Ressource exige `social.manage` sur le Site visé et sur le Site actuel de la Ressource. Les autres routes de gestion exigent `social.manage` sur au moins un Site du Client concerné.
- **Accès de l'agence.** Une Intégration sans Client (accès de l'agence), comme la liste de tous les Clients, ne se gère que par un Utilisateur agence (403 `agency-only`).
- **Erreur.** Droit manquant : 403 Problem Details, `type: "missing-feature"`, avec l'extension `feature`.

**Status:** done

- [x] Les trois Fonctionnalités `social.*` sont présentes dans le seed
- [x] Un utilisateur a une Fonctionnalité sur un Site si un de ses packs ou une surcharge ADD la lui donne, sur ce Site ou sur tous ses Sites, qu'aucune surcharge REMOVE ne la lui retire, et que le Site l'autorise
- [x] Une Fonctionnalité absente du Site n'est jamais accordée, même par surcharge
- [x] Un utilisateur n'a aucun droit sur un Site d'un Client auquel il n'appartient pas
- [x] Un Utilisateur agence a accès à tous les Clients. Ses Fonctionnalités suivent les mêmes règles de packs, surcharges et plafond
- [x] Les routes de gestion des Intégrations renvoient 403 au format Problem Details sans `social.manage`
- [x] Des tests HTTP couvrent chaque règle de calcul via une route protégée
