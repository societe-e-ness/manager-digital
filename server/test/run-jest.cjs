// Lance Jest en le résolvant comme Node le ferait (racine du monorepo ou server/node_modules).
// Les scripts npm l'appellent avec --experimental-vm-modules : openid-client et jose sont
// des modules ESM, que Jest ne sait charger depuis du CommonJS qu'avec ce drapeau.
require("jest/bin/jest");
