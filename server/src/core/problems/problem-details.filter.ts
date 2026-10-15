import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import type { Response } from "express";
import { STATUS_CODES } from "node:http";
import { ProblemException } from "./problem.exception";

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  [extension: string]: unknown;
}

/**
 * Toutes les erreurs HTTP de l'API sortent au format RFC 9457 :
 *  - ProblemException → son `type` stable ;
 *  - autre HttpException de Nest (validation, 404 de route…) → `type: "about:blank"` ;
 *  - erreur inattendue → 500 générique, détail dans les logs, jamais dans la réponse.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const problem = this.toProblem(exception);
    host.switchToHttp().getResponse<Response>().status(problem.status).type("application/problem+json").json(problem);
  }

  private toProblem(exception: unknown): ProblemDetails {
    if (exception instanceof ProblemException) {
      return {
        ...exception.extensions,
        type: exception.type,
        title: exception.title,
        status: exception.getStatus(),
        detail: exception.message,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return { type: "about:blank", title: STATUS_CODES[status] ?? "Error", status, detail: detailOf(exception) };
    }

    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    return { type: "about:blank", title: "Internal Server Error", status: 500, detail: "Erreur interne du serveur" };
  }
}

/** Les exceptions de Nest portent leur message dans `getResponse()`, parfois sous forme de liste. */
function detailOf(exception: HttpException) {
  const response = exception.getResponse();
  if (typeof response === "string") return response;
  const message = (response as { message?: unknown }).message;
  if (Array.isArray(message)) return message.join(" ; ");
  if (typeof message === "string") return message;
  return exception.message;
}
