import { HttpException, HttpStatus } from "@nestjs/common";

/**
 * Une erreur métier au format RFC 9457 (Problem Details).
 * `type` est un identifiant stable que le Plugin WP peut tester ("integration-not-found"…) :
 * ne jamais le renommer une fois publié. `title` et `detail` sont destinés aux humains.
 */
export class ProblemException extends HttpException {
  constructor(
    status: HttpStatus,
    readonly type: string,
    readonly title: string,
    detail: string,
    readonly extensions: Record<string, unknown> = {},
  ) {
    super(detail, status);
  }
}
