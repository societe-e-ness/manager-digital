# 11: Échecs, relance et historique

**What to build:** Les échecs imprévisibles (jeton révoqué entre-temps, contenu refusé par le réseau, panne Meta) ne bloquent qu'une Publication à la fois. Si l'accès par une Intégration échoue, on essaie la suivante qui mène à la même page avant de déclarer l'échec. Une Publication échouée est tracée avec sa raison et peut être relancée. Le Plugin WP peut consulter l'historique des Publications d'une Actualité, et cet historique survit à la déconnexion de l'Intégration qui a servi.

**Blocked by:** 08 (Diffuser une Actualité sur une page Facebook)

Décisions (2026-11-12) :
- **Échec partiel** : déjà en place depuis le 08 (une Publication par Ressource, chacune avec son statut), désormais couvert par un test dédié.
- **Repli d'Intégration** : les accès à la page (Intégrations actives du Client, ou de l'agence, qui ont accordé la publication) sont essayés dans un ordre stable. Seul un refus d'**accès** (`integration-expired`, `permission-missing`) fait passer au suivant. Un contenu refusé ou une panne est le même pour tous : on s'arrête là. Si tous sont refusés, la Publication échoue avec la raison du dernier.
- **Expiration** (ce qui tranche entre le 08 et le 11) : un jeton de page refusé déclenche la vérification du jeton de la personne (`GET /me`). Si celui-ci est refusé, l'Intégration est marquée expirée. S'il est bon, la page lui a été retirée : seul son jeton de page est oublié (lien sans jeton, plus proposé ; la prochaine synchronisation le rend si la page revient), et l'Intégration reste active.
- **Relance** `POST /plugin/publications/:id/retry` (`social.publish`, multipart `images` facultatif) → 200 avec la Publication mise à jour (la même, pas une nouvelle). Même texte et même lien, enregistrés. Les images ne sont pas conservées : le Plugin WP les joint de nouveau, et leur nombre doit être celui d'origine (`image_count`), sinon 422 `retry-images-mismatch` (`imageCount`). Les refus prévisibles du 09 s'appliquent (422 `broadcast-refused`). Erreurs : 404 `publication-not-found` (autre Site), 409 `publication-already-succeeded`, 409 `publication-in-progress`.
- **Envoi interrompu** : une Publication restée « en cours » plus de 15 minutes (`attempted_at`, début du dernier envoi ; coupure de la fonction pendant l'envoi, par exemple) peut être relancée. Deux relances simultanées ne partent pas deux fois (mise à jour conditionnelle).
- **Historique** `GET /plugin/articles/:articleId/publications` (`social.read` ou `social.publish`) : les Publications de l'Actualité sur le Site du jeton, de la plus récente à la plus ancienne, avec leur Ressource (`id`, `type`, `name`), statut, raison, lien, `created_at`, `attempted_at`, `published_at`. Il survit à la déconnexion et au détachement (table `publication` indépendante, Ressource jamais supprimée tant qu'elle est référencée).
- **Migration** `20261112090000_publication_retry` : `image_count` et `attempted_at` sur `publication` (avec `down.sql`, vérifié).
- **Limites laissées** : après un repli, les photos déjà envoyées par un accès refusé restent comme photos non publiées sur la page (comme au 08) ; la relance garde l'auteur et la date de la Diffusion d'origine ; quand tous les accès sont refusés, seule la dernière raison est tracée.

**Status:** done

- [x] Dans une Diffusion vers deux Ressources, l'échec de l'une n'empêche pas la réussite de l'autre, et la réponse donne le statut de chacune
- [x] Une Publication échouée est tracée avec le statut « échouée » et une raison au `type` stable
- [x] Quand le jeton d'une Intégration est refusé par Meta, l'Intégration est marquée expirée et la Diffusion réessaie par une autre Intégration active qui mène à la page
- [x] La relance d'une Publication échouée la renvoie avec le même contenu et met à jour son statut
- [x] Une Publication réussie ne peut pas être relancée (erreur explicite)
- [x] L'historique d'une Actualité liste ses Publications diffusées (Ressource, statut, lien, dates)
- [x] L'historique reste complet après la déconnexion de l'Intégration utilisée
- [x] Des tests HTTP couvrent l'échec partiel, le repli d'Intégration, la relance et l'historique après déconnexion
