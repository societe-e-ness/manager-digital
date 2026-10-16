import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { RightsService } from "./rights.service";

/** Droits : packs, surcharges individuelles et plafond des Fonctionnalités par Site. */
@Module({
  imports: [DatabaseModule],
  providers: [RightsService],
  exports: [RightsService],
})
export class RightsModule {}
