# 06: Rattachement et visibilité selon le Client

**What to build:** Un utilisateur qui a `social.manage` sur un Site rattache des Ressources à ce Site ou les en détache. Un Utilisateur client est ainsi autonome sur les Sites de ses Clients, et seulement ceux-là. Un utilisateur voit les Ressources rattachées aux Sites de ses Clients, quelle que soit la personne qui les a connectées. On ne déconnecte que ses propres Intégrations, et l'agence peut tout déconnecter.

**Blocked by:** 04 (Droits social.*), 05 (Une page = une Ressource)

**Status:** ready-for-agent

- [ ] Rattacher une Ressource à un Site exige `social.manage` sur ce Site
- [ ] Un Utilisateur client ne peut pas rattacher une Ressource à un Site d'un autre Client (403)
- [ ] Une Ressource déjà rattachée à un autre Site ne peut pas être rattachée une seconde fois sans détachement préalable (erreur explicite)
- [ ] Un Utilisateur client voit une Ressource connectée par l'agence dès qu'elle est rattachée à un Site de son Client
- [ ] Un Utilisateur client ne voit ni les Ressources ni les Intégrations des autres Clients
- [ ] Un Utilisateur client peut déconnecter ses propres Intégrations, mais pas celle de l'agence (403)
- [ ] Un Utilisateur agence peut déconnecter n'importe quelle Intégration
- [ ] Des tests HTTP couvrent ces scénarios avec un Utilisateur agence et deux Utilisateurs client de Clients différents
