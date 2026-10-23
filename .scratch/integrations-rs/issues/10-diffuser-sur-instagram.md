# 10: Diffuser sur Instagram

**What to build:** Une Actualité peut être diffusée vers un compte Instagram rattaché au Site. Instagram n'accepte que des URL d'images publiques : le Manager Digital expose les images reçues à une URL publique temporaire le temps de la publication, puis les supprime. Une Diffusion vers Instagram sans image est un refus prévisible. Les permissions Instagram (lecture du compte et publication) sont ajoutées à la connexion Meta.

**Blocked by:** 09 (Refus prévisibles avant Diffusion)

**Status:** ready-for-agent

- [ ] Une Diffusion avec image vers un compte Instagram rattaché crée une Publication Instagram, tracée avec son statut et son lien
- [ ] L'image est servie à une URL publique non devinable, qui cesse de répondre une fois la publication terminée, réussie ou non
- [ ] Une Diffusion vers Instagram sans image est bloquée par la vérification préalable (`type` stable « image requise »)
- [ ] Une Diffusion vers Facebook et Instagram à la fois crée une Publication par Ressource
- [ ] La connexion Meta demande les permissions Instagram nécessaires
- [ ] Des tests HTTP, avec le faux Graph, couvrent la publication (création du conteneur puis publication) et le refus sans image
