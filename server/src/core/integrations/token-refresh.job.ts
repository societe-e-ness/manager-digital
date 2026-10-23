import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { DatabaseService } from "../database/database.service";
import { IntegrationsService } from "./integrations.service";
import { MetaService } from "./meta.service";

/**
 * Les jetons utilisateur Meta durent 60 jours et ne se rafraîchissent que tant qu'ils
 * sont valides. Ce job les renouvelle en avance, et signale ceux qu'on n'a pas pu sauver.
 * Les jetons de page n'expirent pas : rien à faire pour eux.
 */
@Injectable()
export class TokenRefreshJob {
  private readonly logger = new Logger(TokenRefreshJob.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly integrations: IntegrationsService,
    private readonly meta: MetaService,
  ) {}

  /** Toutes les heures : rafraîchit les jetons qui expirent dans les 24 h. */
  @Cron(CronExpression.EVERY_HOUR)
  async refreshExpiringTokens() {
    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const expiring = await this.db.integration.findMany({
      where: { status: "ACTIVE", expires_at: { lte: soon } },
    });

    for (const integration of expiring) {
      try {
        await this.meta.refresh(integration);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.logger.warn(`Rafraîchissement impossible pour l'intégration ${integration.id} : ${message}`);
        await this.integrations.markAsExpired(integration.id);
      }
    }
  }

  /**
   * Tous les matins : prévient avant que les chiffres ne s'arrêtent.
   * TODO : envoyer un mail de reconnexion quand le module mail existera.
   */
  @Cron(CronExpression.EVERY_DAY_AT_8AM)
  async notifyExpiredIntegrations() {
    const expired = await this.db.integration.findMany({ where: { status: { in: ["EXPIRED", "REVOKED"] } } });
    for (const integration of expired) {
      this.logger.warn(
        `Intégration Meta ${integration.id} (client ${integration.client_id ?? "agence"}) en ${integration.status} : reconnexion à demander`,
      );
    }
  }
}
