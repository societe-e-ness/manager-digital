# 06: Rattachement et visibilité selon le Client

**What to build:** Un utilisateur qui a `social.manage` sur un Site rattache des Ressources à ce Site ou les en détache. Un Utilisateur client est ainsi autonome sur les Sites de ses Clients, et seulement ceux-là. Un utilisateur voit les Ressources rattachées aux Sites de ses Clients, quelle que soit la personne qui les a connectées. On ne déconnecte que ses propres Intégrations, et l'agence peut tout déconnecter.

**Blocked by:** 04 (Droits social.*), 05 (Une page = une Ressource)

Points relevés à la revue du ticket 04 :
- Le callback OAuth réutilise une Intégration existante sur `external_user_id` sans tenir compte de son Client : reconnecter pour le Client A un compte Meta déjà connecté pour le Client B met à jour l'Intégration de B et la renvoie.
- `GET /integrations?clientId=…` renvoie les Intégrations du Client, pas encore les Ressources rattachées à ses Sites par d'autres.

Points relevés à la revue du ticket 05 (une Ressource est maintenant partagée entre Intégrations) :
- Rattacher une Ressource non rattachée ne contrôle que le Site visé : un Client peut prendre une page atteinte seulement par l'Intégration d'un autre Client.
- La liste des Intégrations d'un Client montre, pour chaque Ressource, `site_id` et `accessible` calculés sur les Intégrations de tous les Clients.

Décisions (2026-10-21) :
- **Rattacher une Ressource libre** exige `social.manage` sur le Site visé, et qu'une Intégration du Client de ce Site y mène (ou un accès de l'agence, pour un Utilisateur agence) : sinon 403 `resource-not-reachable`. Une Ressource rattachée ailleurs : 409 `resource-already-attached`, y compris en cas de rattachement simultané.
- **Visibilité.** Nouvelle route `GET /integrations/resources?clientId=…` : les Ressources rattachées aux Sites du Client, quelle que soit la personne qui les a connectées, et les Ressources libres atteintes par ses Intégrations. Dans le détail d'une Intégration, une Ressource rattachée au Site d'un Client invisible apparaît avec `site_id: null` et `attached_elsewhere: true`.
- **« Ses propres Intégrations »** = celles dont on est `created_by` ; une reconnexion en fait changer. Sinon 403 `not-integration-owner`.
- **Une Intégration par compte Meta et par Client** (migration `integration_per_client`) : les points de la revue du ticket 04 sont réglés.

**Status:** done

- [x] Rattacher une Ressource à un Site exige `social.manage` sur ce Site
- [x] Un Utilisateur client ne peut pas rattacher une Ressource à un Site d'un autre Client (403)
- [x] Une Ressource déjà rattachée à un autre Site ne peut pas être rattachée une seconde fois sans détachement préalable (erreur explicite)
- [x] Un Utilisateur client voit une Ressource connectée par l'agence dès qu'elle est rattachée à un Site de son Client
- [x] Un Utilisateur client ne voit ni les Ressources ni les Intégrations des autres Clients
- [x] Un Utilisateur client peut déconnecter ses propres Intégrations, mais pas celle de l'agence (403)
- [x] Un Utilisateur agence peut déconnecter n'importe quelle Intégration
- [x] Des tests HTTP couvrent ces scénarios avec un Utilisateur agence et deux Utilisateurs client de Clients différents
