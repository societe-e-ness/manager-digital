import type { ConfigService } from "@nestjs/config";
import type { Request, Response } from "express";

const SESSION_COOKIE = "md_session";
// connexion SSO en cours (state, nonce, PKCE chiffrés), envoyé seulement au retour d'auth.eness
const SSO_FLOW_COOKIE = "md_sso";
const SSO_FLOW_PATH = "/auth/sso";

/** Un cookie lu dans l'en-tête Cookie, sans dépendance supplémentaire. */
function readCookie(req: Request, cookieName: string) {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name !== cookieName) continue;
    try {
      return decodeURIComponent(value.join("="));
    } catch {
      return undefined; // cookie abîmé : traité comme absent (401), pas comme une erreur serveur
    }
  }
  return undefined;
}

/**
 * httpOnly : inaccessible au JavaScript de la page. Secure en production (HTTPS).
 * SameSite=Lax (et pas Strict) : sinon le cookie ne serait pas renvoyé au retour d'auth.eness.
 */
function cookieOptions(config: ConfigService) {
  return { httpOnly: true, sameSite: "lax" as const, secure: config.get("NODE_ENV") === "production", path: "/" };
}

export function readSessionCookie(req: Request) {
  return readCookie(req, SESSION_COOKIE);
}

export function setSessionCookie(res: Response, config: ConfigService, token: string, expiresAt: Date) {
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(config), expires: expiresAt });
}

export function clearSessionCookie(res: Response, config: ConfigService) {
  res.clearCookie(SESSION_COOKIE, cookieOptions(config));
}

export function readSsoFlowCookie(req: Request) {
  return readCookie(req, SSO_FLOW_COOKIE);
}

export function setSsoFlowCookie(res: Response, config: ConfigService, flow: string, maxAgeMs: number) {
  res.cookie(SSO_FLOW_COOKIE, flow, { ...cookieOptions(config), path: SSO_FLOW_PATH, maxAge: maxAgeMs });
}

export function clearSsoFlowCookie(res: Response, config: ConfigService) {
  res.clearCookie(SSO_FLOW_COOKIE, { ...cookieOptions(config), path: SSO_FLOW_PATH });
}
