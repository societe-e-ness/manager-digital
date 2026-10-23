import { Controller, Get } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.service";
import { CurrentUser } from "../auth/session.guard";
import { RightsService } from "./rights.service";

/**
 *   GET /me/clients → les Clients que l'utilisateur voit (tous pour l'agence), avec leurs Sites
 */
@Controller("me")
export class MeController {
  constructor(private readonly rights: RightsService) {}

  @Get("clients")
  clients(@CurrentUser() user: AuthenticatedUser) {
    return this.rights.visibleClientsWithSites(user);
  }
}
