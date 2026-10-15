import { HttpStatus, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomBytes } from "node:crypto";
import type { User, UserType } from "../../generated/prisma/client";
import { DatabaseService } from "../database/database.service";
import { ProblemException } from "../problems/problem.exception";
import { MagicLinkSender } from "./magic-link.sender";

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
// la session glisse à chaque visite, mais on ne réécrit son expiration qu'au plus une fois par heure
const SESSION_EXTEND_EVERY_MS = 60 * 60 * 1000;

/** L'utilisateur connecté, tel que les routes le reçoivent. */
export interface AuthenticatedUser {
  id: number;
  email: string;
  name: string | null;
  type: UserType;
}

/**
 * Connexion par lien magique et sessions.
 * Les jetons (lien et cookie) ne sont jamais stockés en clair : seul leur SHA-256 l'est.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    private readonly sender: MagicLinkSender,
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
      return tx.session.create({
        data: {
          id: sha256(sessionToken),
          user_id,
          method: "MAGIC_LINK",
          expires_at: new Date(Date.now() + SESSION_TTL_MS),
          user_agent: userAgent,
        },
        include: { user: true },
      });
    });

    return { sessionToken, expiresAt: session.expires_at, user: toAuthenticatedUser(session.user) };
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
    const session = await this.db.session.findUnique({ where: { id: sha256(sessionToken) }, include: { user: true } });
    if (!session || session.revoked_at || session.expires_at.getTime() <= Date.now()) return null;

    let expiresAt = session.expires_at;
    const extended = SESSION_TTL_MS - (expiresAt.getTime() - Date.now()) > SESSION_EXTEND_EVERY_MS;
    if (extended) {
      expiresAt = new Date(Date.now() + SESSION_TTL_MS);
      await this.db.session.update({ where: { id: session.id }, data: { expires_at: expiresAt } });
    }

    return { user: toAuthenticatedUser(session.user), expiresAt, extended };
  }

  async revokeSession(sessionToken: string) {
    await this.db.session.updateMany({
      where: { id: sha256(sessionToken), revoked_at: null },
      data: { revoked_at: new Date() },
    });
  }
}

function newToken() {
  return randomBytes(32).toString("base64url");
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function toAuthenticatedUser({ id, email, name, type }: User): AuthenticatedUser {
  return { id, email, name, type };
}
