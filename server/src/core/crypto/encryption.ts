import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Chiffrement AES-256-GCM des secrets stockés (jetons Meta, refresh tokens SSO…).
// Valeur stockée (base64) : [ IV 12 octets | tag 16 octets | données chiffrées ]
//  - l'IV est aléatoire : deux chiffrements du même texte donnent deux résultats
//  - le tag garantit que la valeur n'a pas été modifiée

/** La clé lue dans ENCRYPTION_KEY (32 octets en base64). */
export function encryptionKey(base64: string) {
  return Buffer.from(base64, "base64");
}

export function encrypt(key: Buffer, plain: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}

/** Lève une erreur si la clé est mauvaise ou si la valeur a été altérée. */
export function decrypt(key: Buffer, stored: string) {
  const buffer = Buffer.from(stored, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, buffer.subarray(0, 12));
  decipher.setAuthTag(buffer.subarray(12, 28));
  return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString("utf8");
}
