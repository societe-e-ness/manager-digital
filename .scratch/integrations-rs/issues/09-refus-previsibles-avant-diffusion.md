# 09: Refus prévisibles avant Diffusion

**What to build:** Avant de diffuser, le Plugin WP peut demander une vérification sans envoi. Elle renvoie, pour chaque Ressource cible, les refus prévisibles : ceux qu'on peut déduire sans appeler le réseau. Une Diffusion qui contient au moins un refus prévisible est entièrement bloquée, et rien ne part vers Meta. Le Plugin WP peut ainsi prévenir l'utilisateur et l'empêcher de lancer l'action.

**Blocked by:** 08 (Diffuser une Actualité sur une page Facebook)

**Status:** ready-for-agent

- [ ] La route de vérification renvoie, par Ressource cible, la liste des refus prévisibles, chacun avec un `type` stable
- [ ] Les refus détectés comprennent au moins : permission Meta non accordée, aucune Intégration active vers la Ressource, texte trop long pour le réseau, format ou nombre d'images non accepté
- [ ] Une Diffusion avec au moins un refus prévisible est rejetée en entier (erreur Problem Details listant les refus), sans aucun appel à Meta
- [ ] Une Diffusion sans refus prévisible se comporte comme dans le ticket 08
- [ ] Des tests HTTP couvrent chaque refus, et vérifient que le faux Graph n'a reçu aucun appel
