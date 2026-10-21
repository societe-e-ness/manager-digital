# 06: Rattachement et visibilité selon le Client

**What to build:** Un utilisateur qui a `social.manage` sur un Site rattache des Ressources à ce Site ou les en détache. Un Utilisateur client est ainsi autonome sur les Sites de ses Clients, et seulement ceux-là. Un utilisateur voit les Ressources rattachées aux Sites de ses Clients, quelle que soit la personne qui les a connectées. On ne déconnecte que ses propres Intégrations, et l'agence peut tout déconnecter.

**Blocked by:** 04 (Droits social.*), 05 (Une page = une Ressource)

Points relevés à la revue du ticket 04 :
- Le callback OAuth réutilise une Intégration existante sur `external_user_id` sans tenir compte de son Client : reconnecter pour le Client A un compte Meta déjà connecté pour le Client B met à jour l'Intégration de B et la renvoie.
- `GET /integrations?clientId=…` renvoie les Intégrations du Client, pas encore les Ressources rattachées à ses Sites par d'autres.

Points relevés à la revue du ticket 05 (une Ressource est maintenant partagée entre Intégrations) :
- Rattacher une Ressource non rattachée ne contrôle que le Site visé : un Client peut prendre une page atteinte seulement par l'Intégration d'un autre Client.
- La liste des Intégrations d'un Client montre, pour chaque Ressource, `site_id` et `accessible` calculés sur les Intégrations de tous les Clients.

**Status:** ready-for-agent

- [ ] Rattacher une Ressource à un Site exige `social.manage` sur ce Site
- [ ] Un Utilisateur client ne peut pas rattacher une Ressource à un Site d'un autre Client (403)
- [ ] Une Ressource déjà rattachée à un autre Site ne peut pas être rattachée une seconde fois sans détachement préalable (erreur explicite)
- [ ] Un Utilisateur client voit une Ressource connectée par l'agence dès qu'elle est rattachée à un Site de son Client
- [ ] Un Utilisateur client ne voit ni les Ressources ni les Intégrations des autres Clients
- [ ] Un Utilisateur client peut déconnecter ses propres Intégrations, mais pas celle de l'agence (403)
- [ ] Un Utilisateur agence peut déconnecter n'importe quelle Intégration
- [ ] Des tests HTTP couvrent ces scénarios avec un Utilisateur agence et deux Utilisateurs client de Clients différents
