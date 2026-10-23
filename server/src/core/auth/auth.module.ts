import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { DatabaseModule } from "../database/database.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { LogMagicLinkSender, MagicLinkSender } from "./magic-link.sender";
import { SessionGuard } from "./session.guard";
import { SsoController } from "./sso.controller";
import { SsoService } from "./sso.service";

/**
 * Connexion (SSO auth.eness, lien magique en secours) et sessions.
 * SessionGuard est global : toute route exige une session, sauf @Public().
 */
@Module({
  imports: [DatabaseModule],
  controllers: [AuthController, SsoController],
  providers: [
    AuthService,
    SsoService,
    { provide: MagicLinkSender, useClass: LogMagicLinkSender },
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
  exports: [AuthService],
})
export class AuthModule {}
