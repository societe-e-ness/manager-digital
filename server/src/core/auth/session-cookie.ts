import type { ConfigService } from "@nestjs/config";
import type { Request, Response } from "express";

const SESSION_COOKIE = "md_session";

/** Le jeton de session lu dans l'en-tête Cookie, sans dépendance supplémentaire. */
export function readSessionCookie(req: Request) {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name !== SESSION_COOKIE) continue;
    try {
      return decodeURIComponent(value.join("="));
    } catch {
      return undefined; // cookie abîmé : traité comme absent (401), pas comme une erreur serveur
    }
  }
  return undefined;
}

/** httpOnly : inaccessible au JavaScript de la page. Secure en production (HTTPS). */
function cookieOptions(config: ConfigService) {
  return { httpOnly: true, sameSite: "lax" as const, secure: config.get("NODE_ENV") === "production", path: "/" };
}

export function setSessionCookie(res: Response, config: ConfigService, token: string, expiresAt: Date) {
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(config), expires: expiresAt });
}

export function clearSessionCookie(res: Response, config: ConfigService) {
  res.clearCookie(SESSION_COOKIE, cookieOptions(config));
}
