# 11: Échecs, relance et historique

**What to build:** Les échecs imprévisibles (jeton révoqué entre-temps, contenu refusé par le réseau, panne Meta) ne bloquent qu'une Publication à la fois. Si l'accès par une Intégration échoue, on essaie la suivante qui mène à la même page avant de déclarer l'échec. Une Publication échouée est tracée avec sa raison et peut être relancée. Le Plugin WP peut consulter l'historique des Publications d'une Actualité, et cet historique survit à la déconnexion de l'Intégration qui a servi.

**Blocked by:** 08 (Diffuser une Actualité sur une page Facebook)

**Status:** ready-for-agent

- [ ] Dans une Diffusion vers deux Ressources, l'échec de l'une n'empêche pas la réussite de l'autre, et la réponse donne le statut de chacune
- [ ] Une Publication échouée est tracée avec le statut « échouée » et une raison au `type` stable
- [ ] Quand le jeton d'une Intégration est refusé par Meta, l'Intégration est marquée expirée et la Diffusion réessaie par une autre Intégration active qui mène à la page
- [ ] La relance d'une Publication échouée la renvoie avec le même contenu et met à jour son statut
- [ ] Une Publication réussie ne peut pas être relancée (erreur explicite)
- [ ] L'historique d'une Actualité liste ses Publications diffusées (Ressource, statut, lien, dates)
- [ ] L'historique reste complet après la déconnexion de l'Intégration utilisée
- [ ] Des tests HTTP couvrent l'échec partiel, le repli d'Intégration, la relance et l'historique après déconnexion
