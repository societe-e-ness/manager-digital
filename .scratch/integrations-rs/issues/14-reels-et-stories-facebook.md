# 14: Reels et stories Facebook

**What to build:** Une Actualité peut être diffusée en **reel**, c'est-à-dire en vidéo verticale, sur Instagram et sur une page Facebook, et en **story** sur une page Facebook. Le Plugin WP envoie l'URL publique de la vidéo, décrite comme les images du ticket 10. Meta traite la vidéo de façon asynchrone, parfois pendant plusieurs minutes : le Manager Digital attend qu'elle soit prête avant de publier, sans dépasser la durée maximale d'une requête sur Vercel.

**Blocked by:** 10 (Diffuser sur Instagram : images en URL, champ `format`)

**Status:** needs-triage

- [ ] Une cible peut porter le `format` `reel` (Instagram, page Facebook) ou `story` vers une page Facebook. Une vidéo est décrite par `{ url, mimeType, width, height, size, duration }`
- [ ] Un reel crée une Publication tracée avec son statut et son lien, une fois la vidéo traitée par Meta
- [ ] L'attente du traitement ne bloque pas la requête au-delà de la durée maximale permise par Vercel. Une Publication encore en traitement reste « en cours » et son statut est mis à jour ensuite (mécanisme à décider : interrogation différée, tâche planifiée…)
- [ ] Refus prévisibles vidéo, avec des `type` stables : vidéo requise, format, durée, proportions et poids hors limites. Les limites sont tirées de la documentation Meta à jour, avec la source citée
- [ ] Une story Facebook (une image ou une vidéo) crée une Publication tracée
- [ ] La connexion Meta demande les permissions éventuellement nécessaires en plus
- [ ] Des tests HTTP, avec le faux Graph, couvrent le reel Instagram, le reel Facebook, la story Facebook, l'attente du traitement et chaque refus sans appel à Meta
