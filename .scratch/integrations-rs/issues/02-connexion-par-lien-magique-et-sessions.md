# 02: Connexion par lien magique et sessions

**What to build:** Un utilisateur, agence ou client, demande un lien magique avec son email, le reçoit, clique et obtient une session. Le lien est à usage unique, expire en environ 15 minutes et n'est jamais stocké en clair. La session est glissante et révocable. Les routes de gestion des Intégrations exigent une session : l'utilisateur vient de la session, plus d'un paramètre de requête. Tant que le module mail n'existe pas, l'envoi du lien passe par un point d'envoi remplaçable, que les tests peuvent lire.

**Blocked by:** 01 (Banc de test HTTP et erreurs standard)

**Status:** done

- [x] Demander un lien pour un email connu crée un lien à usage unique, valable environ 15 minutes, stocké haché
- [x] Demander un lien pour un email inconnu renvoie la même réponse, pour ne pas révéler les comptes existants
- [x] Valider le lien crée une session (méthode : lien magique) et pose un cookie httpOnly
- [x] Un lien déjà utilisé ou expiré est refusé avec une erreur Problem Details
- [x] Une session révoquée ou expirée est refusée
- [x] Les routes de gestion des Intégrations renvoient 401 sans session
- [x] La connexion d'un compte Meta prend l'utilisateur dans la session, plus dans un paramètre de requête
- [x] Des tests HTTP couvrent le parcours complet : demande, validation, appel authentifié, déconnexion
