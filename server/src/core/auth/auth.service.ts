import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomBytes } from "node:crypto";
import type { LoginMethod, Session, User, UserType } from "../../generated/prisma/client";
import { DatabaseService } from "../database/database.service";
import { ProblemException } from "../problems/problem.exception";
import { MagicLinkSender } from "./magic-link.sender";
import { SsoService, type SsoIdentity } from "./sso.service";

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
// la session glisse à chaque visite, mais on ne réécrit son expiration qu'au plus une fois par heure
const SESSION_EXTEND_EVERY_MS = 60 * 60 * 1000;
// une session SSO est revérifiée auprès d'auth.eness au plus tard toutes les 10 minutes
const SSO_RECHECK_MS = 10 * 60 * 1000;

/** L'utilisateur connecté, tel que les routes le reçoivent. */
export interface AuthenticatedUser {
  id: number;
  email: string;
  name: string | null;
  type: UserType;
  role: string | null; // rôle auth.eness (session SSO uniquement)
}

/**
 * Connexion (SSO auth.eness, lien magique en secours) et sessions.
 * Les jetons (lien et cookie) ne sont jamais stockés en clair : seul leur SHA-256 l'est.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    private readonly sender: MagicLinkSender,
    private readonly sso: SsoService,
  ) {}

  // --- Lien magique ---------------------------------------------------------

  /** Envoie un lien si l'email est connu. Ne dit jamais s'il l'est. */
  async requestMagicLink(email: string) {
    const user = await this.findUserByEmail(email);
    if (!user) return;

    const token = newToken();
    await this.db.loginToken.create({
      data: { user_id: user.id, hash: sha256(token), expires_at: new Date(Date.now() + MAGIC_LINK_TTL_MS) },
    });

    const link = new URL("/connexion", this.config.getOrThrow<string>("CLIENT_PUBLIC_URL"));
    link.searchParams.set("token", token);
    await this.sender.send(user.email, link.toString());
  }

  /** Consomme le lien (usage unique) et ouvre une session. */
  async verifyMagicLink(token: string, userAgent?: string) {
    const hash = sha256(token);
    const now = new Date();

    // un seul UPDATE conditionnel : deux clics simultanés ne peuvent pas ouvrir deux sessions
    // en transaction : si la session ne peut pas être créée, le lien n'est pas grillé
    const sessionToken = newToken();
    const session = await this.db.$transaction(async (tx) => {
      const { count } = await tx.loginToken.updateMany({
        where: { hash, used_at: null, expires_at: { gt: now } },
        data: { used_at: now },
      });
      if (count !== 1) {
        throw new ProblemException(
          HttpStatus.UNAUTHORIZED,
          "magic-link-invalid",
          "Lien de connexion invalide",
          "Ce lien a expiré, a déjà été utilisé ou n'existe pas : en demander un nouveau",
        );
      }

      const { user_id } = await tx.loginToken.findUniqueOrThrow({ where: { hash } });
      return tx.session.create({ data: newSession(sessionToken, user_id, "MAGIC_LINK", userAgent), include: { user: true } });
    });

    return { sessionToken, expiresAt: session.expires_at, user: toAuthenticatedUser(session.user, session) };
  }

  // --- SSO --------------------------------------------------------------------

  /**
   * Ouvre une session pour une identité vérifiée par auth.eness. Les comptes sont créés
   * à la main : une identité inconnue est refusée. À la première connexion, la personne
   * est retrouvée par son email, puis son `sub` (immuable) est enregistré.
   */
  async loginWithSso(identity: SsoIdentity, userAgent?: string) {
    const user = (await this.db.user.findUnique({ where: { sso_subject: identity.sub } })) ?? (await this.linkSsoAccount(identity));

    // le type agence / client est géré dans le Manager Digital : on signale seulement l'écart
    if (identity.type && identity.type !== user.type) {
      this.logger.warn(`Utilisateur ${user.id} : type ${user.type} ici, ${identity.type} dans auth.eness`);
    }

    const sessionToken = newToken();
    const session = await this.db.session.create({
      data: {
        ...newSession(sessionToken, user.id, "SSO", userAgent),
        role: identity.role,
        sso_sid: identity.sid,
        id_token: identity.idToken,
        refresh_token: identity.refreshToken,
        checked_at: new Date(),
      },
    });
    return { sessionToken, expiresAt: session.expires_at, user: toAuthenticatedUser(user, session) };
  }

  /**
   * Recherche insensible à la casse. L'index unique, lui, y est sensible : si deux comptes
   * ne diffèrent que par la casse, seul celui écrit exactement pareil est retenu.
   */
  private async findUserByEmail(email: string) {
    const wanted = email.trim();
    const users = await this.db.user.findMany({ where: { email: { equals: wanted, mode: "insensitive" } }, take: 2 });
    return users.length === 1 ? users[0] : users.find((u) => u.email === wanted);
  }

  // --- Sessions -------------------------------------------------------------

  /**
   * La session derrière un jeton de cookie, ou null si elle est absente, révoquée ou expirée.
   * Prolonge la session (glissante) : `extended` dit s'il faut renvoyer le cookie.
   */
  async resolveSession(sessionToken: string) {
    let session = await this.db.session.findUnique({ where: { id: sha256(sessionToken) }, include: { user: true } });
    if (!session || session.revoked_at || session.expires_at.getTime() <= Date.now()) return null;

    if (session.method === "SSO") {
      const rechecked = await this.recheckSso(session);
      if (!rechecked) return null;
      session = { ...session, ...rechecked };
    }

    let expiresAt = session.expires_at;
    const extended = SESSION_TTL_MS - (expiresAt.getTime() - Date.now()) > SESSION_EXTEND_EVERY_MS;
    if (extended) {
      expiresAt = new Date(Date.now() + SESSION_TTL_MS);
      await this.db.session.update({ where: { id: session.id }, data: { expires_at: expiresAt } });
    }

    return { user: toAuthenticatedUser(session.user, session), expiresAt, extended };
  }

  /** Révoque la session et la renvoie (pour la déconnexion côté auth.eness), ou null. */
  async revokeSession(sessionToken: string) {
    const id = sha256(sessionToken);
    const { count } = await this.db.session.updateMany({ where: { id, revoked_at: null }, data: { revoked_at: new Date() } });
    return count === 1 ? this.db.session.findUnique({ where: { id } }) : null;
  }

  /** Back-channel : ferme les sessions ouvertes depuis cette session SSO, ou toutes celles de la personne. */
  async revokeSsoSessions({ sid, sub }: { sid?: string; sub?: string }) {
    const target = sid ? { sso_sid: sid } : { method: "SSO" as const, user: { sso_subject: sub } };
    await this.db.session.updateMany({ where: { ...target, revoked_at: null }, data: { revoked_at: new Date() } });
  }

  /**
   * Première connexion SSO : rattache le compte auth.eness au compte existant de même email.
   * Seulement si auth.eness garantit l'email (email_verified) : sinon n'importe qui pourrait
   * se déclarer avec l'email d'un autre et prendre son compte.
   */
  private async linkSsoAccount(identity: SsoIdentity) {
    const byEmail = identity.emailVerified ? await this.findUserByEmail(identity.email) : undefined;
    if (byEmail && !byEmail.sso_subject) {
      // conditionnel : deux premières connexions simultanées ne se marchent pas dessus
      await this.db.user.updateMany({ where: { id: byEmail.id, sso_subject: null }, data: { sso_subject: identity.sub } });
      const linked = await this.db.user.findUnique({ where: { sso_subject: identity.sub } });
      if (linked) return linked;
    }
    // inconnu, email non vérifié, ou email déjà rattaché à un autre compte auth.eness
    throw new ProblemException(
      HttpStatus.FORBIDDEN,
      "sso-unknown-user",
      "Compte inconnu du Manager Digital",
      "Ce compte auth.eness n'a pas de compte Manager Digital : demander à l'agence de le créer",
    );
  }

  /**
   * Toutes les 10 minutes, redemande à auth.eness si l'accès tient toujours.
   * Renvoie les champs mis à jour, ou null si la session a dû être révoquée.
   */
  private async recheckSso(session: Session): Promise<Partial<Session> | null> {
    if (session.checked_at && Date.now() - session.checked_at.getTime() < SSO_RECHECK_MS) return {};

    // une seule requête revérifie : auth.eness renouvelle le refresh token à chaque usage,
    // deux revérifications simultanées s'invalideraient l'une l'autre
    const { count } = await this.db.session.updateMany({
      where: { id: session.id, checked_at: session.checked_at },
      data: { checked_at: new Date() },
    });
    if (count === 0) return {};

    const fresh = await this.sso.recheck(session.refresh_token, session.role);
    if (fresh.status === "unavailable") return {}; // panne : on garde la session, nouvel essai dans 10 minutes
    if (fresh.status === "lost") {
      await this.db.session.update({ where: { id: session.id }, data: { revoked_at: new Date() } });
      return null;
    }
    return this.db.session.update({
      where: { id: session.id },
      data: {
        role: fresh.role,
        id_token: fresh.idToken ?? session.id_token,
        refresh_token: fresh.refreshToken ?? session.refresh_token,
      },
    });
  }
}

function newToken() {
  return randomBytes(32).toString("base64url");
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function newSession(sessionToken: string, userId: number, method: LoginMethod, userAgent?: string) {
  return {
    id: sha256(sessionToken),
    user_id: userId,
    method,
    expires_at: new Date(Date.now() + SESSION_TTL_MS),
    user_agent: userAgent,
  };
}

function toAuthenticatedUser({ id, email, name, type }: User, session: Pick<Session, "role">): AuthenticatedUser {
  return { id, email, name, type, role: session.role };
}
