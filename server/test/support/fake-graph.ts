import { assertNoUnexpectedCalls, interceptHost, jsonResponse, releaseHost } from "./network";

const GRAPH_HOST = "graph.facebook.com";

interface Route {
  method: string;
  path: string;
  status: number;
  body: unknown;
  query: Record<string, string>;
}

export interface GraphCall {
  method: string;
  path: string; // sans la version : "/me/accounts"
  query: URLSearchParams;
  body?: string; // formulaire encodé : new URLSearchParams(call.body)
  form?: FormData; // envoi multipart (photos)
}

/**
 * Un faux Graph API Meta : seules les routes déclarées avec `on()` répondent.
 * Tout autre appel est refusé et signalé par `assertNoUnexpectedCalls()`.
 */
export class FakeGraph {
  readonly calls: GraphCall[] = [];
  private routes: Route[] = [];

  install() {
    this.calls.length = 0;
    this.routes = [];
    interceptHost(GRAPH_HOST, ({ method, url, body, form }) => {
      const path = url.pathname.replace(/^\/v\d+\.\d+/, "");
      const route = this.routes.find(
        (r) =>
          r.method === method &&
          r.path === path &&
          Object.entries(r.query).every(([name, value]) => url.searchParams.get(name) === value),
      );
      if (!route) return undefined;
      this.calls.push({ method, path, query: url.searchParams, body, form });
      return jsonResponse(route.body, route.status);
    });
  }

  uninstall() {
    releaseHost(GRAPH_HOST);
  }

  /** Oublie les réponses déclarées (les appels déjà faits restent dans `calls`). */
  reset() {
    this.routes = [];
    return this;
  }

  /**
   * Déclare une réponse. `path` sans la version de l'API : "/me/accounts".
   * `query` restreint la réponse aux appels portant ces paramètres ; la première route qui correspond gagne.
   */
  on(method: string, path: string, body: unknown, status = 200, query: Record<string, string> = {}) {
    this.routes.push({ method: method.toUpperCase(), path, status, body, query });
    return this;
  }

  assertNoUnexpectedCalls() {
    assertNoUnexpectedCalls();
  }
}
