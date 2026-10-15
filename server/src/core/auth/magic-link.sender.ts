import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/**
 * Le point d'envoi des liens magiques. Remplaçable : les tests branchent un faux
 * qui garde les liens, et le module mail prendra le relais quand il existera.
 */
export abstract class MagicLinkSender {
  abstract send(email: string, link: string): Promise<void>;
}

/**
 * En attendant le module mail : le lien est écrit dans les logs, hors production.
 * TODO mail : remplacer par un envoi réel.
 */
@Injectable()
export class LogMagicLinkSender extends MagicLinkSender {
  private readonly logger = new Logger("MagicLink");

  constructor(private readonly config: ConfigService) {
    super();
  }

  async send(email: string, link: string) {
    if (this.config.get("NODE_ENV") === "production") {
      // un lien magique dans les logs de production = un accès au compte pour qui les lit
      this.logger.error(`Lien magique demandé pour ${email}, mais aucun module mail n'est branché`);
      return;
    }
    this.logger.log(`Lien magique pour ${email} : ${link}`);
  }
}
