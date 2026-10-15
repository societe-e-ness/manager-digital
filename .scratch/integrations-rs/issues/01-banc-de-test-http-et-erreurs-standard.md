# 01: Banc de test HTTP et erreurs standard

**What to build:** Préparatoire. Les tests peuvent appeler l'application réelle du Manager Digital par HTTP, sur une base PostgreSQL de test. Les appels sortants vers la Graph API de Meta sont interceptés au niveau du réseau par un faux Graph qui renvoie des réponses enregistrées. Toutes les erreurs de l'API sortent au format RFC 9457 (Problem Details), avec un `type` stable par cas. Voir la spec : [docs/specs/integrations-rs.md](../../../docs/specs/integrations-rs.md), section Testing Decisions.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Une commande lance les tests HTTP contre une application Nest complète et une base de test, remise à zéro entre les tests
- [ ] Un faux Graph Meta intercepte les appels vers Meta. Un appel non prévu fait échouer le test au lieu de partir sur le réseau
- [ ] Les erreurs de l'API sont renvoyées au format Problem Details (`type`, `title`, `status`, `detail`), avec le bon type de contenu
- [ ] Un test HTTP vérifie la route de santé
- [ ] Un test HTTP vérifie qu'une Intégration introuvable renvoie une erreur 404 au format Problem Details, avec un `type` stable
- [ ] La dépendance de développement ajoutée pour les requêtes HTTP est une version stable, épinglée exactement et vérifiée sur npm
- [ ] Les tests unitaires existants (chiffrement, state signé) passent toujours
