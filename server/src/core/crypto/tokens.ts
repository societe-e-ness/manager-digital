import { createHash, randomBytes } from "node:crypto";

// Jetons opaques (lien magique, session, OAuth du Plugin WP) : seul leur SHA-256 est stocké.

/** 256 bits aléatoires, lisibles dans une URL. */
export function newToken() {
  return randomBytes(32).toString("base64url");
}

/** L'empreinte stockée en base à la place du jeton. */
export function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
