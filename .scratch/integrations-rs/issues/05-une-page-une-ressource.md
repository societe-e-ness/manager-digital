# 05: Une page = une Ressource

**What to build:** Une Ressource (page Facebook, compte Instagram, compte publicitaire) est unique par réseau, type et identifiant externe, quelle que soit la personne qui l'a connectée. Plusieurs Intégrations peuvent y mener. Le jeton propre d'une page est rattaché au lien entre Intégration et Ressource. Déconnecter une Intégration supprime ses liens, et ne supprime une Ressource que si plus rien n'y mène ni ne la référence. Une Ressource sans Intégration active est signalée comme inaccessible.

**Blocked by:** 01 (Banc de test HTTP et erreurs standard)

**Status:** ready-for-agent

- [ ] Connecter deux comptes Meta qui ont accès à la même page produit une seule Ressource, reliée aux deux Intégrations
- [ ] Le rattachement à un Site est porté par la Ressource, pas par le lien avec l'Intégration
- [ ] Re-synchroniser une Intégration met à jour les Ressources existantes, sans en créer de doublon
- [ ] Déconnecter une Intégration conserve une Ressource encore atteignable par une autre Intégration, avec son rattachement au Site
- [ ] Déconnecter la dernière Intégration d'une Ressource la supprime si rien ne la référence, et la garde marquée inaccessible sinon
- [ ] Une Ressource dont toutes les Intégrations sont expirées ou révoquées apparaît comme inaccessible
- [ ] Aucun jeton n'apparaît jamais dans les réponses de l'API
- [ ] La migration est réversible sur une base vide et documentée si elle touche des données existantes
- [ ] Des tests HTTP, avec le faux Graph, couvrent la double connexion et la déconnexion
