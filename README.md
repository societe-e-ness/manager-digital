# Manager Digital

Monorepo npm workspaces : un seul `package-lock.json` et un seul `node_modules`, à la racine.

```
manager-digital/
├── package.json   workspaces, scripts communs, overrides npm
├── server/        API backend (NestJS 11 + Prisma 7 + PostgreSQL)
├── client/        Front web (React 19 + Vite 8 + React Router 8)
└── README.md
```

## Commandes (depuis la racine)

```sh
npm install              # installe server et client
npm run build            # build des deux workspaces
npm run typecheck        # vérification TypeScript des deux workspaces
npm run dev:server       # API en mode watch (port 3000)
npm run dev:client       # front Vite (port 5173)
```

Pour ajouter une dépendance à un workspace, toujours depuis la racine :

```sh
npm install --save-exact <paquet>@<version> -w server
npm install --save-exact <paquet>@<version> -w client
```

Ne jamais lancer `npm install` depuis `server/` ou `client/` : cela recréerait un lockfile local.

## Frontend (`client/`)

| Outil                | Version |
| -------------------- | ------- |
| React / React DOM    | 19.3.0  |
| Vite                 | 8.3.1   |
| @vitejs/plugin-react | 6.1.1   |
| React Router         | 8.4.0, en data mode (`createBrowserRouter` + `RouterProvider`) |
| TypeScript           | 5.9.3, la même version que le serveur |

Configuration issue du modèle officiel `create-vite` react-ts, sans lint, CSS ni ressources de démo.
Les routes sont déclarées dans `client/src/router.tsx`.

## Backend (`server/`)

| Outil           | Version  |
| --------------- | -------- |
| Node.js         | 24 LTS   |
| NestJS          | 11.2.6   |
| TypeScript      | 5.9.3    |
| Prisma          | 7.10.0   |
| @prisma/client  | 7.10.0   |
| Base de données | PostgreSQL, via `@prisma/adapter-pg` |

Toutes les versions sont épinglées exactement.

### Démarrage

```sh
cp server/.env.example server/.env   # puis renseigner DATABASE_URL
npm install                          # depuis la racine
npm run build -w server              # lance prisma generate puis nest build
npm run dev:server
```

### Prisma 7

- `server/prisma.config.ts` porte le chemin du schéma, des migrations et l'URL de connexion.
- `server/prisma/schema.prisma` utilise le générateur `prisma-client` en CommonJS.
  Le client est généré dans `server/src/generated/prisma` (ignoré, régénéré au build).
- Le runtime se connecte via le driver adapter `PrismaPg` (`server/src/prisma/prisma.service.ts`).
- Les variables d'environnement sont chargées explicitement avec `dotenv`.

### ⚠️ Ne pas utiliser `@latest` pour Prisma

Sur npm, le tag `latest` de `prisma` pointe vers une **8.0.0-rc**, et NestJS `latest` est en **12.x**.
Toujours installer des versions explicites, par exemple :

```sh
npm install --save-exact --save-dev prisma@7.10.0 -w server
npm install --save-exact @prisma/client@7.10.0 @prisma/adapter-pg@7.10.0 -w server
```

`prisma` et `@prisma/client` doivent toujours avoir la même version exacte.
Ignorer le bandeau « Update available 7.10.0 -> 8.0.0-rc » affiché par le CLI.

## Surcharges npm (`overrides`)

Elles sont déclarées dans le `package.json` **racine**, car npm ignore les `overrides` d'un workspace.

Prisma 7.10.0, dernière version 7.x, épingle deux dépendances transitives vulnérables du CLI :

| Paquet       | Épinglé par Prisma | Surchargé en | Avis                                     |
| ------------ | ------------------ | ------------ | ---------------------------------------- |
| deepmerge-ts | 7.1.5              | 8.0.2        | GHSA-ggr8-5vv4-36mx                      |
| mysql2       | 3.15.3             | 3.24.4       | GHSA-3f6p-5ww8-9rcr, GHSA-rgwj-5xj2-c3m3 |

Ces surcharges ne concernent que le CLI Prisma, pas le code exécuté par l'API.
`prisma validate`, `prisma generate` et le build ont été vérifiés avec elles.
À retirer si une future 7.x corrige ces dépendances.

Le CLI inclut aussi Prisma Studio, qui dépend de paquets `@visx/*` en `4.0.x-alpha`.
Ils sont imposés par Prisma et ne sont pas utilisés par l'application.

Les scripts d'installation de `prisma` et `@prisma/engines` sont autorisés via `allowScripts` dans le `package.json` racine.
