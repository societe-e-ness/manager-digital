# 05: Une page = une Ressource

**What to build:** Une Ressource (page Facebook, compte Instagram, compte publicitaire) est unique par réseau, type et identifiant externe, quelle que soit la personne qui l'a connectée. Plusieurs Intégrations peuvent y mener. Le jeton propre d'une page est rattaché au lien entre Intégration et Ressource. Déconnecter une Intégration supprime ses liens, et ne supprime une Ressource que si plus rien n'y mène ni ne la référence. Une Ressource sans Intégration active est signalée comme inaccessible.

**Blocked by:** 01 (Banc de test HTTP et erreurs standard)

Décisions (2026-10-21) :
- **Schéma.** Table `resource` (unique par réseau, type, identifiant externe ; porte le rattachement au Site) et table de liaison `integration_resource` (porte le jeton de page). La migration convertit les données existantes sur place ; `down.sql` vaut pour une base vide.
- **Accessible** est calculé (au moins une Intégration ACTIVE y mène), pas stocké.
- **« Rien ne la référence »** = pas de rattachement à un Site, pour l'instant ; le ticket 11 ajoutera les Publications diffusées.
- **Re-synchroniser retire les liens** vers ce que l'Intégration n'atteint plus, avec le même nettoyage qu'à la déconnexion. La pagination de Meta est donc suivie jusqu'au bout.
- Supprimer une page ne supprime plus son compte Instagram (`parent_id` passe à null), qui peut être rattaché à un Site.

**Status:** done

- [x] Connecter deux comptes Meta qui ont accès à la même page produit une seule Ressource, reliée aux deux Intégrations
- [x] Le rattachement à un Site est porté par la Ressource, pas par le lien avec l'Intégration
- [x] Re-synchroniser une Intégration met à jour les Ressources existantes, sans en créer de doublon
- [x] Déconnecter une Intégration conserve une Ressource encore atteignable par une autre Intégration, avec son rattachement au Site
- [x] Déconnecter la dernière Intégration d'une Ressource la supprime si rien ne la référence, et la garde marquée inaccessible sinon
- [x] Une Ressource dont toutes les Intégrations sont expirées ou révoquées apparaît comme inaccessible
- [x] Aucun jeton n'apparaît jamais dans les réponses de l'API
- [x] La migration est réversible sur une base vide et documentée si elle touche des données existantes
- [x] Des tests HTTP, avec le faux Graph, couvrent la double connexion et la déconnexion
