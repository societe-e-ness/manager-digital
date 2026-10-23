import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { RightsModule } from "../rights/rights.module";
import { IntegrationsController } from "./integrations.controller";
import { IntegrationsService } from "./integrations.service";
import { MetaService } from "./meta.service";
import { TokenRefreshJob } from "./token-refresh.job";

/**
 * Connexion des comptes Meta Ads des clients.
 * Les autres modules n'importent que IntegrationsService (quelles connexions ?)
 * et MetaService (quelles données ?).
 */
@Module({
  imports: [DatabaseModule, RightsModule],
  controllers: [IntegrationsController],
  providers: [IntegrationsService, MetaService, TokenRefreshJob],
  exports: [IntegrationsService, MetaService],
})
export class IntegrationsModule {}
